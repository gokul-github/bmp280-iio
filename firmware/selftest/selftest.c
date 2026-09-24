/*
 * Host-side proof of the compensation path. No QEMU, no kernel.
 *   make && ./selftest
 *
 * Locks the §3.12 bench vector and checks that a physical setpoint
 * encoded to raw ADC comes back out of the integer driver formulas.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "../qemu/bmp280_math.h"

static int g_fail;

static void expect_eq_i(const char *name, long long got, long long want)
{
    if (got != want) {
        fprintf(stderr, "FAIL %s: got %lld want %lld\n", name, got, want);
        g_fail++;
    } else {
        printf("ok   %s = %lld\n", name, got);
    }
}

static void expect_near(const char *name, double got, double want, double tol)
{
    if (fabs(got - want) > tol) {
        fprintf(stderr, "FAIL %s: got %.6f want %.6f\n", name, got, want);
        g_fail++;
    } else {
        printf("ok   %s = %.5f\n", name, got);
    }
}

static void roundtrip_centi(int32_t centi)
{
    const Bmp280Calib *c = &bmp280_sample_calib;
    int32_t adc = bmp280_adc_for_centi(c, centi);
    Bmp280TempOut t = bmp280_compensate_T_int32(c, adc);
    char name[64];

    snprintf(name, sizeof name, "roundtrip T %d centi (adc %d)", centi, adc);
    expect_eq_i(name, t.t_centi, centi);
}

static void roundtrip_pa(int32_t centi, double pa)
{
    const Bmp280Calib *c = &bmp280_sample_calib;
    int32_t adc_t = bmp280_adc_for_centi(c, centi);
    Bmp280TempOut t = bmp280_compensate_T_int32(c, adc_t);
    uint32_t target_q = (uint32_t)llround(pa * 256.0);
    int32_t adc_p = bmp280_adc_for_q24(c, t.t_fine, target_q);
    uint32_t q = bmp280_compensate_P_int64(c, t.t_fine, adc_p);
    long long dq = (long long)q - (long long)target_q;
    char name[80];

    if (dq < 0) {
        dq = -dq;
    }
    /* Integer pressure moves ~0.18 Pa per ADC count, so the closest
     * code can sit up to half a step off the requested Pa. */
    snprintf(name, sizeof name, "roundtrip P %.1f Pa within 0.25 Pa", pa);
    if (dq > 64) {
        fprintf(stderr, "FAIL %s: q %u target %u adc_p %d (dq %lld)\n",
                name, q, target_q, adc_p, dq);
        g_fail++;
    } else {
        printf("ok   %s (adc_p %d, dq %lld)\n", name, adc_p, dq);
    }
}

int main(void)
{
    const Bmp280Calib *c = &bmp280_sample_calib;
    uint8_t raw[3], regs[256];
    Bmp280TempOut t = bmp280_compensate_T_int32(c, 519888);
    uint32_t p = bmp280_compensate_P_int64(c, t.t_fine, 415148);

    /* §3.12: UT 519888 → 25.08 °C, t_fine 128422.
     * UP 415148 → integer code. The figure prints 25767236; executing
     * the published 64-bit formula yields 25767233 (0.01 Pa, inside the
     * footnote about integer rounding versus the float drawing). */
    expect_eq_i("t_centi", t.t_centi, 2508);
    expect_eq_i("t_fine", t.t_fine, 128422);
    expect_eq_i("p_q24.8", p, 25767233);
    expect_near("p_Pa", p / 256.0, 100653.27, 0.05);

    bmp280_pack20(raw, 0xABCDE);
    expect_eq_i("pack20", bmp280_unpack20(raw), 0xABCDE);
    bmp280_pack20(raw, 519888);
    expect_eq_i("pack UT", bmp280_unpack20(raw), 519888);

    {
        int i;
        for (i = 0; i < 256; i++) {
            regs[i] = 0;
        }
    }
    bmp280_store_calib(regs, c);
    expect_eq_i("dig_T1 le", regs[0x88] | (regs[0x89] << 8), 27504);
    expect_eq_i("dig_T3 le", (int16_t)(regs[0x8C] | (regs[0x8D] << 8)), -1000);
    expect_eq_i("dig_P9 le", (int16_t)(regs[0x9E] | (regs[0x9F] << 8)), 6000);

    roundtrip_centi(2508);
    roundtrip_centi(-4000);
    roundtrip_centi(0);
    roundtrip_centi(8500);
    roundtrip_centi(2250);

    roundtrip_pa(2508, 100653.25390625);
    roundtrip_pa(2250, 101325.0);
    roundtrip_pa(1500, 90000.0);
    roundtrip_pa(-1000, 110000.0);
    roundtrip_pa(4000, 30000.0);

    if (g_fail) {
        fprintf(stderr, "%d failure(s)\n", g_fail);
        return 1;
    }
    printf("all checks passed\n");
    return 0;
}
