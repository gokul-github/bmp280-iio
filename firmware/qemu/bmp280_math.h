/*
 * BMP280 compensation, register packing, and inverse ADC encoding.
 *
 * Integer formulas are Bosch datasheet BST-BMP280-DS001-11 rev 1.1
 * (§3.11.3 temperature, §3.11.3 64-bit pressure). The floating-point
 * forms are appendix 8.1, with the temperature var2 term squared as
 * required by the worked example in §3.12 (the printed listing drops
 * a parenthesis). Sample calibration is the §3.12 bench vector.
 *
 * Header-only so the QEMU device, the kernel-side reference, and the
 * host self-test all execute the same arithmetic. No QEMU dependency.
 */
#ifndef BMP280_MATH_H
#define BMP280_MATH_H

#include <stdint.h>

typedef struct Bmp280Calib {
    uint16_t T1;
    int16_t T2;
    int16_t T3;
    uint16_t P1;
    int16_t P2, P3, P4, P5, P6, P7, P8, P9;
} Bmp280Calib;

/* §3.12 sample trimming values. dig_P3 is 3024. */
static const Bmp280Calib bmp280_sample_calib = {
    27504, 26435, -1000,
    36477, -10685, 3024, 2855, 140, -7, 15500, -14600, 6000
};

typedef struct Bmp280TempOut {
    int32_t t_fine;
    int32_t t_centi; /* 0.01 °C. 2508 means 25.08 °C. */
} Bmp280TempOut;

static inline Bmp280TempOut bmp280_compensate_T_int32(const Bmp280Calib *c,
                                                      int32_t adc_T)
{
    int32_t var1, var2;
    Bmp280TempOut o;

    var1 = ((((adc_T >> 3) - ((int32_t)c->T1 << 1))) * ((int32_t)c->T2)) >> 11;
    var2 = (((((adc_T >> 4) - (int32_t)c->T1) *
              ((adc_T >> 4) - (int32_t)c->T1)) >> 12) * (int32_t)c->T3) >> 14;
    o.t_fine = var1 + var2;
    o.t_centi = (o.t_fine * 5 + 128) >> 8;
    return o;
}

/* Pressure in Q24.8 Pa (value/256 = Pa). 0 if the divisor vanishes. */
static inline uint32_t bmp280_compensate_P_int64(const Bmp280Calib *c,
                                                 int32_t t_fine,
                                                 int32_t adc_P)
{
    int64_t var1, var2, p;

    var1 = ((int64_t)t_fine) - 128000;
    var2 = var1 * var1 * (int64_t)c->P6;
    var2 = var2 + ((var1 * (int64_t)c->P5) << 17);
    var2 = var2 + (((int64_t)c->P4) << 35);
    var1 = ((var1 * var1 * (int64_t)c->P3) >> 8) + ((var1 * (int64_t)c->P2) << 12);
    var1 = (((((int64_t)1) << 47) + var1) * ((int64_t)c->P1)) >> 33;
    if (var1 == 0) {
        return 0;
    }
    p = 1048576 - (int64_t)adc_P;
    p = (((p << 31) - var2) * 3125) / var1;
    var1 = (((int64_t)c->P9) * (p >> 13) * (p >> 13)) >> 25;
    var2 = (((int64_t)c->P8) * p) >> 19;
    p = ((p + var1 + var2) >> 8) + (((int64_t)c->P7) << 4);
    return (uint32_t)p;
}

static inline void bmp280_pack20(uint8_t b[3], uint32_t adc)
{
    adc &= 0xFFFFFu;
    b[0] = (uint8_t)((adc >> 12) & 0xFF);
    b[1] = (uint8_t)((adc >> 4) & 0xFF);
    b[2] = (uint8_t)((adc & 0xF) << 4);
}

static inline uint32_t bmp280_unpack20(const uint8_t b[3])
{
    return ((uint32_t)b[0] << 12) | ((uint32_t)b[1] << 4) | ((uint32_t)b[2] >> 4);
}

/*
 * Invert the integer temperature formula. adc_T is monotonic in t_centi
 * for the sample calibration across the -40…+85 °C operating range.
 * Returns the 20-bit code whose compensated value is closest to target.
 */
static inline int32_t bmp280_adc_for_centi(const Bmp280Calib *c, int32_t target)
{
    int lo = 0;
    int hi = 0xFFFFF;
    int32_t best, best_err, err, mid;

    while (lo < hi) {
        mid = (lo + hi) >> 1;
        if (bmp280_compensate_T_int32(c, mid).t_centi < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    best = lo;
    best_err = bmp280_compensate_T_int32(c, lo).t_centi - target;
    if (best_err < 0) {
        best_err = -best_err;
    }
    if (lo > 0) {
        err = bmp280_compensate_T_int32(c, lo - 1).t_centi - target;
        if (err < 0) {
            err = -err;
        }
        if (err < best_err) {
            best = lo - 1;
        }
    }
    return best;
}

/* Invert Q24.8 pressure. Compensated pressure falls as adc_P rises. */
static inline int32_t bmp280_adc_for_q24(const Bmp280Calib *c, int32_t t_fine,
                                        uint32_t target_q)
{
    int lo = 0;
    int hi = 0xFFFFF;
    int32_t best;
    uint32_t q_lo, q_hi_cand;
    int64_t err_best, err;

    while (lo < hi) {
        int mid = (lo + hi) >> 1;
        uint32_t q = bmp280_compensate_P_int64(c, t_fine, mid);
        if (q > target_q) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    best = lo;
    q_lo = bmp280_compensate_P_int64(c, t_fine, lo);
    err_best = (int64_t)q_lo - (int64_t)target_q;
    if (err_best < 0) {
        err_best = -err_best;
    }
    if (lo > 0) {
        q_hi_cand = bmp280_compensate_P_int64(c, t_fine, lo - 1);
        err = (int64_t)q_hi_cand - (int64_t)target_q;
        if (err < 0) {
            err = -err;
        }
        if (err < err_best) {
            best = lo - 1;
        }
    }
    return best;
}

static inline void bmp280_store_calib(uint8_t regs[256], const Bmp280Calib *c)
{
    const uint16_t words[12] = {
        c->T1, (uint16_t)c->T2, (uint16_t)c->T3,
        c->P1, (uint16_t)c->P2, (uint16_t)c->P3, (uint16_t)c->P4,
        (uint16_t)c->P5, (uint16_t)c->P6, (uint16_t)c->P7,
        (uint16_t)c->P8, (uint16_t)c->P9
    };
    int i;

    for (i = 0; i < 12; i++) {
        regs[0x88 + 2 * i] = (uint8_t)(words[i] & 0xFF);
        regs[0x88 + 2 * i + 1] = (uint8_t)((words[i] >> 8) & 0xFF);
    }
}

#endif /* BMP280_MATH_H */
