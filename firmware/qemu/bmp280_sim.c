/*
 * BMP280 I²C slave for QEMU.
 *
 * Drop-in for QEMU 9.x:
 *   cp bmp280_sim.c bmp280_math.h  hw/sensor/
 *   In hw/sensor/meson.build:
 *     system_ss.add(when: 'CONFIG_BMP280_SIM', if_true: files('bmp280_sim.c'))
 *   In hw/sensor/Kconfig (or hw/arm/Kconfig):
 *     config BMP280_SIM
 *         bool
 *         default y
 *         depends on I2C
 *   In hw/arm/versatilepb.c, after the versatile_i2c bus exists:
 *     i2c_slave_create_simple(i2c, TYPE_BMP280_SIM, 0x76);
 *
 * Host stimulus (stage 1), either form:
 *   -device bmp280-sim,address=0x76,input=/tmp/bmp280_sim_input
 *   echo "25.4 1013.25" > /tmp/bmp280_sim_input
 *   echo LIVE > /tmp/bmp280_sim_input          # back to sine + noise
 * or a chardev, one line at a time:
 *   -chardev socket,id=bmp,host=127.0.0.1,port=4444,server=on,wait=off
 *   -device bmp280-sim,address=0x76,chardev=bmp
 *
 * Address 0x76 is SDO low, 0x77 is SDO high. The I²C core NACKs any other
 * address, which is what the guest driver sees when the DT reg disagrees.
 *
 * Implements datasheet §§3.6, 3.9, 3.10, 4, 5.2: pointer + auto-increment,
 * burst read, soft reset 0xB6, forced mode returning to sleep, normal mode
 * paced by t_sb, IIR filter, and register shadowing across an open read.
 */

#include "qemu/osdep.h"
#include "hw/i2c/i2c.h"
#include "hw/qdev-properties.h"
#include "hw/qdev-properties-system.h"
#include "migration/vmstate.h"
#include "qemu/module.h"
#include "qemu/timer.h"
#include "chardev/char-fe.h"
#include "qapi/error.h"

#include "bmp280_math.h"

#include <math.h>
#include <stdio.h>

#define TYPE_BMP280_SIM "bmp280-sim"
OBJECT_DECLARE_SIMPLE_TYPE(BMP280State, BMP280_SIM)

#define REG_ID     0xD0
#define REG_RESET  0xE0
#define REG_STATUS 0xF3
#define REG_CTRL   0xF4
#define REG_CONFIG 0xF5
#define REG_PRESS  0xF7
#define REG_TEMP   0xFA

struct BMP280State {
    I2CSlave parent_obj;
    uint8_t regs[256];
    uint8_t shadow[6];
    bool shadow_pending;
    bool in_burst;
    uint8_t ptr;
    bool ptr_latched;
    bool filt_t_ok;
    bool filt_p_ok;
    int32_t filt_t;
    int32_t filt_p;
    bool live;
    double temp_c;
    double press_hpa;
    uint32_t rng;
    char *input_path;
    CharBackend chr;
    uint8_t line[96];
    int line_len;
    QEMUTimer *timer;
};

static const double standby_ms[8] = {
    0.5, 62.5, 125, 250, 500, 1000, 2000, 4000
};

static const int filter_coeff[8] = { 0, 2, 4, 8, 16, 16, 16, 16 };

static uint32_t bmp280_rng(BMP280State *s)
{
    uint32_t x = s->rng ? s->rng : 0xA5C31E77u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    s->rng = x;
    return x;
}

static void bmp280_load_identity(BMP280State *s)
{
    uint8_t id = 0x58;
    memset(s->regs, 0, sizeof s->regs);
    s->regs[REG_ID] = id;
    s->regs[REG_PRESS] = 0x80;
    s->regs[REG_TEMP] = 0x80;
    bmp280_store_calib(s->regs, &bmp280_sample_calib);
    s->filt_t_ok = false;
    s->filt_p_ok = false;
    s->shadow_pending = false;
    s->in_burst = false;
    s->ptr = 0;
    s->ptr_latched = false;
}

static int32_t bmp280_iir(int32_t *mem, bool *valid, int32_t adc, int coeff)
{
    int32_t v;

    if (coeff <= 1 || !*valid) {
        *mem = adc;
        *valid = true;
        return adc;
    }
    v = (int32_t)(((int64_t)(*mem) * (coeff - 1) + adc) / coeff);
    *mem = v;
    return v;
}

static void bmp280_store_sample(BMP280State *s, uint32_t adc_t, uint32_t adc_p)
{
    uint8_t *dst = s->in_burst ? s->shadow : &s->regs[REG_PRESS];
    bmp280_pack20(dst, adc_p);
    bmp280_pack20(dst + 3, adc_t);
    if (s->in_burst) {
        s->shadow_pending = true;
    } else {
        s->regs[REG_STATUS] = 0x00;
    }
}

static void bmp280_convert(BMP280State *s)
{
    const Bmp280Calib *c = &bmp280_sample_calib;
    int osrs_t = (s->regs[REG_CTRL] >> 5) & 7;
    int osrs_p = (s->regs[REG_CTRL] >> 2) & 7;
    int coeff = filter_coeff[(s->regs[REG_CONFIG] >> 2) & 7];
    int32_t centi = (int32_t)llround(s->temp_c * 100.0);
    int32_t raw_t = bmp280_adc_for_centi(c, centi);
    Bmp280TempOut tf = bmp280_compensate_T_int32(c, raw_t);
    uint32_t target_q = (uint32_t)llround(s->press_hpa * 100.0 * 256.0);
    int32_t raw_p = bmp280_adc_for_q24(c, tf.t_fine, target_q);
    uint32_t out_t = 0x80000;
    uint32_t out_p = 0x80000;

    /* measuring bit is high only while this function runs. */
    s->regs[REG_STATUS] = 0x08;

    if (osrs_t != 0) {
        out_t = (uint32_t)bmp280_iir(&s->filt_t, &s->filt_t_ok, raw_t, coeff);
    }
    if (osrs_p != 0) {
        out_p = (uint32_t)bmp280_iir(&s->filt_p, &s->filt_p_ok, raw_p, coeff);
    }
    bmp280_store_sample(s, out_t, out_p);
    if (!s->in_burst) {
        s->regs[REG_STATUS] = 0x00;
    }
}

static void bmp280_parse_line(BMP280State *s, const char *line)
{
    double t, p;

    while (*line == ' ' || *line == '\t') {
        line++;
    }
    if (strncmp(line, "LIVE", 4) == 0) {
        s->live = true;
        return;
    }
    if (sscanf(line, "T %lf P %lf", &t, &p) == 2 ||
        sscanf(line, "%lf %lf", &t, &p) == 2) {
        s->temp_c = t;
        s->press_hpa = p;
        s->live = false;
        return;
    }
    if (sscanf(line, "T %lf", &t) == 1 || sscanf(line, "%lf", &t) == 1) {
        s->temp_c = t;
        s->live = false;
    }
}

static void bmp280_poll_file(BMP280State *s)
{
    FILE *f;
    char line[96];

    if (!s->input_path || !s->input_path[0]) {
        return;
    }
    f = fopen(s->input_path, "r");
    if (!f) {
        return;
    }
    if (fgets(line, sizeof line, f)) {
        bmp280_parse_line(s, line);
    }
    fclose(f);
}

static void bmp280_refresh_setpoint(BMP280State *s)
{
    double sec;

    bmp280_poll_file(s);
    if (!s->live) {
        return;
    }
    sec = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) / 1e9;
    s->temp_c = 24.6 + 1.7 * sin(sec / 7.5) + 0.45 * sin(sec / 2.1);
    s->press_hpa = 1013.25 + 1.35 * sin(sec / 13.0) + 0.35 * sin(sec / 3.4);
    s->temp_c += ((int)(bmp280_rng(s) % 1000) - 500) / 10000.0;
    s->press_hpa += ((int)(bmp280_rng(s) % 1000) - 500) / 50000.0;
}

static void bmp280_arm(BMP280State *s, bool immediate)
{
    int tsb = (s->regs[REG_CONFIG] >> 5) & 7;
    int64_t delay = immediate ? 0 : (int64_t)(standby_ms[tsb] * 1000000.0);
    if (delay < 500000) {
        delay = 500000;
    }
    timer_mod_ns(s->timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + delay);
}

static void bmp280_timer(void *opaque)
{
    BMP280State *s = opaque;

    if ((s->regs[REG_CTRL] & 3) != 3) {
        return;
    }
    bmp280_refresh_setpoint(s);
    bmp280_convert(s);
    bmp280_arm(s, false);
}

static int bmp280_can_receive(void *opaque)
{
    BMP280State *s = opaque;
    return (int)sizeof(s->line) - s->line_len - 1;
}

static void bmp280_receive(void *opaque, const uint8_t *buf, int size)
{
    BMP280State *s = opaque;
    int i;

    for (i = 0; i < size; i++) {
        if (buf[i] == '\n' || s->line_len >= (int)sizeof(s->line) - 1) {
            s->line[s->line_len] = 0;
            if (s->line_len) {
                bmp280_parse_line(s, (char *)s->line);
            }
            s->line_len = 0;
        } else if (buf[i] != '\r') {
            s->line[s->line_len++] = buf[i];
        }
    }
}

static int bmp280_event(I2CSlave *i2c, enum i2c_event event)
{
    BMP280State *s = BMP280_SIM(i2c);

    switch (event) {
    case I2C_START_SEND:
        s->ptr_latched = false;
        break;
    case I2C_START_RECV:
        s->in_burst = true;
        break;
    case I2C_FINISH:
        if (s->shadow_pending) {
            memcpy(&s->regs[REG_PRESS], s->shadow, 6);
            s->shadow_pending = false;
            s->regs[REG_STATUS] = 0x00;
        }
        s->in_burst = false;
        s->ptr_latched = false;
        break;
    case I2C_NACK:
        break;
    default:
        break;
    }
    return 0;
}

static uint8_t bmp280_recv(I2CSlave *i2c)
{
    BMP280State *s = BMP280_SIM(i2c);
    uint8_t v = s->regs[s->ptr];
    s->ptr++;
    return v;
}

static int bmp280_send(I2CSlave *i2c, uint8_t data)
{
    BMP280State *s = BMP280_SIM(i2c);
    uint8_t reg;

    if (!s->ptr_latched) {
        s->ptr = data;
        s->ptr_latched = true;
        return 0;
    }
    reg = s->ptr++;

    if (reg == REG_RESET) {
        if (data == 0xB6) {
            timer_del(s->timer);
            bmp280_load_identity(s);
        }
        return 0;
    }
    if (reg == REG_CONFIG) {
        int old = (s->regs[REG_CONFIG] >> 2) & 7;
        s->regs[REG_CONFIG] = data;
        if (((data >> 2) & 7) != old) {
            s->filt_t_ok = false;
            s->filt_p_ok = false;
        }
        if ((s->regs[REG_CTRL] & 3) == 3) {
            bmp280_arm(s, false);
        }
        return 0;
    }
    if (reg == REG_CTRL) {
        s->regs[REG_CTRL] = data;
        if ((data & 3) == 1 || (data & 3) == 2) {
            bmp280_refresh_setpoint(s);
            bmp280_convert(s);
            s->regs[REG_CTRL] &= ~0x03;
            timer_del(s->timer);
        } else if ((data & 3) == 3) {
            bmp280_arm(s, true);
        } else {
            timer_del(s->timer);
        }
        return 0;
    }
    /* Chip id, calibration and data registers are not host-writable. */
    return 0;
}

static void bmp280_realize(DeviceState *dev, Error **errp)
{
    BMP280State *s = BMP280_SIM(dev);
    (void)errp;

    bmp280_load_identity(s);
    s->live = true;
    s->temp_c = 25.0;
    s->press_hpa = 1013.25;
    s->rng = 0xC0FFEE01u;
    s->line_len = 0;
    s->timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, bmp280_timer, s);
    if (qemu_chr_fe_backend_connected(&s->chr)) {
        qemu_chr_fe_set_handlers(&s->chr, bmp280_can_receive, bmp280_receive,
                                 NULL, NULL, s, NULL, true);
    }
}

static const VMStateDescription vmstate_bmp280 = {
    .name = "bmp280-sim",
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_I2C_SLAVE(parent_obj, BMP280State),
        VMSTATE_UINT8_ARRAY(regs, BMP280State, 256),
        VMSTATE_UINT8(ptr, BMP280State),
        VMSTATE_BOOL(ptr_latched, BMP280State),
        VMSTATE_BOOL(live, BMP280State),
        VMSTATE_END_OF_LIST()
    }
};

static const Property bmp280_props[] = {
    DEFINE_PROP_CHR("chardev", BMP280State, chr),
    DEFINE_PROP_STRING("input", BMP280State, input_path),
};

static void bmp280_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    I2CSlaveClass *k = I2C_SLAVE_CLASS(klass);
    (void)data;

    dc->realize = bmp280_realize;
    dc->vmsd = &vmstate_bmp280;
    k->event = bmp280_event;
    k->recv = bmp280_recv;
    k->send = bmp280_send;
    device_class_set_props(dc, bmp280_props);
}

static const TypeInfo bmp280_info = {
    .name = TYPE_BMP280_SIM,
    .parent = TYPE_I2C_SLAVE,
    .instance_size = sizeof(BMP280State),
    .class_init = bmp280_class_init,
};

static void bmp280_register_types(void)
{
    type_register_static(&bmp280_info);
}

type_init(bmp280_register_types)
