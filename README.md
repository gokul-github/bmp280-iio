# BMP280 I²C pipeline

Bosch BMP280 barometric pressure and temperature sensor.
Datasheet BST-BMP280-DS001-11 rev 1.1.
Chip id `0x58` at register `0xD0`.
I²C address `0x76` when SDO is grounded, `0x77` when SDO is pulled up.

A physical value is written in from the host, stored as a 20-bit ADC code, burst-read by a Linux IIO driver, compensated with the datasheet integer formulas, and drawn on a scope. The browser bench and the QEMU slave run the same calibration image and the same formulas.

| Stage | Code | What you see |
| --- | --- | --- |
| 1. Stimulus | `firmware/userspace/inject.py`, lab knobs | Temperature in °C, pressure in hPa |
| 2. Device | `firmware/qemu/bmp280_sim.c`, `src/lib/bmp280/` | Register file, including `0xF7..0xFC` |
| 3. Probe | device tree + `bmp280_read_id` | ACK at the strapped address, id `0x58` |
| 4. Init | `bmp280_probe` | Calibration loaded, sensor left in normal mode |
| 5. Read | `bmp280_read_raw` | `in_temp_input`, `in_pressure_input` |
| 6. Scope | lab chart, `firmware/userspace/iio_watch.py` | Injected trace against the driver trace |

Target board for the C path: ARM Versatile/PB (`qemu-system-arm -M versatilepb`). The board already has an `arm,versatile-i2c` controller at `0x10002000`.

Compensation is BST-BMP280-DS001-11 §3.11.3, locked to the §3.12 trimming vector:

| Quantity | Value |
| --- | --- |
| `adc_T` | 519888 |
| `adc_P` | 415148 |
| Integer temperature | 2508 (25.08 °C), `t_fine` 128422 |
| Integer pressure | 25767233 in Q24.8 (100653.25 Pa) |

The figure in the datasheet prints 25767236. The published 64-bit formula yields 25767233. The difference is 0.01 Pa, which the footnote allows. `firmware/selftest` locks both numbers.

## Prerequisites

Host self-test (any machine with a C11 toolchain):

```sh
sudo apt update
sudo apt install build-essential
```

Kernel module, cross-built for the Versatile guest:

```sh
sudo apt install gcc-arm-linux-gnueabihf
```

`KDIR` must point at a kernel tree configured for Versatile/PB with `CONFIG_I2C`, `CONFIG_I2C_VERSATILE`, and `CONFIG_IIO`. Turn the in-tree `CONFIG_BMP280` **off**. This module and the stock Bosch driver both match `bosch,bmp280`.

QEMU device (only if you want the guest to talk to a simulated chip): a QEMU 9.x tree you can rebuild. See [QEMU device](#qemu-device) below.

Web bench:

- Node.js 22 or newer
- npm 10 or newer

Python 3 is enough for `inject.py` and `iio_watch.py`. No extra packages.

## Clone

```sh
git clone https://github.com/gokul-github/bmp280-iio.git
cd bmp280-iio
```

`firmware/selftest/selftest` is not in git. Build it locally.

## Layout

```
firmware/qemu/bmp280_sim.c     QEMU I²C slave (type "bmp280-sim")
firmware/qemu/bmp280_math.h    §3.11.3 integer compensation and the inverse
firmware/kernel/bmp280.c       out-of-tree IIO driver
firmware/dts/bmp280-versatile.dtsi
firmware/userspace/inject.py   write a setpoint into the host file QEMU polls
firmware/userspace/iio_watch.py
firmware/selftest/             host check of the datasheet vector
src/lib/bmp280/                TypeScript port of the same model
src/components/bmp-lab.tsx     bench: registers, probe trace, scope
src/components/scope-chart.tsx
src/routes/index.tsx           serves the bench at /
```

## 1. Simulation of the inputs

The QEMU slave does not invent a sensor behind the ADC. It takes a temperature and a pressure, inverts the integer compensation (binary search over the 20-bit code), and writes those codes into `0xF7..0xFC`. A still setpoint comes back out of the driver within 0.01 °C and about 0.2 Pa.

Two ways to feed it.

**Host file**, re-read on every conversion. Temperature is °C. Pressure is hPa. A single number is temperature only; pressure stays where it was.

```sh
echo "25.4 1013.25" > /tmp/bmp280_sim_input
echo "25.4" > /tmp/bmp280_sim_input
echo LIVE > /tmp/bmp280_sim_input

python3 firmware/userspace/inject.py 25.4 1013.25
python3 firmware/userspace/inject.py --repl
python3 firmware/userspace/inject.py --live
```

`LIVE` (also the power-on default when the file is absent or empty of a number) replaces the setpoint with a slow pair of sines plus a little noise:

- temperature: `24.6 + 1.7·sin(t/7.5) + 0.45·sin(t/2.1)` °C
- pressure: `1013.25 + 1.35·sin(t/13) + 0.35·sin(t/3.4)` hPa

**Chardev**, one line at a time, same parser (`25.4 1013.25`, `T 25.4 P 1013.25`, or `LIVE`):

```sh
-chardev socket,id=bmp,host=127.0.0.1,port=4444,server=on,wait=off
-device bmp280-sim,address=0x76,chardev=bmp
```

The browser bench has the same two stimuli. **Live** is the sine pair. **Bench** holds the knobs still. Noise on the bench is applied in the model before the inverse compensation; the QEMU file path adds its noise only in `LIVE`.

Oversampling `000` does not convert. The device stores the skipped sentinel `0x80000` and leaves that channel's IIR memory alone. A skipped channel reads back as no data.

## 2. QEMU device

Copy into a QEMU 9.x tree:

```sh
cp firmware/qemu/bmp280_sim.c firmware/qemu/bmp280_math.h hw/sensor/
```

`hw/sensor/meson.build`:

```meson
system_ss.add(when: 'CONFIG_BMP280_SIM', if_true: files('bmp280_sim.c'))
```

`hw/sensor/Kconfig`:

```text
config BMP280_SIM
    bool
    default y
    depends on I2C
```

`hw/arm/versatilepb.c`, once `i2c` is the Versatile I²C bus. `i2c_slave_create_simple` cannot pass `input=` or `chardev=`. Use it only when the default `LIVE` waveform is enough:

```c
i2c_slave_create_simple(i2c, "bmp280-sim", 0x76);
```

For a host file, the bus has to be reachable from the command line:

```sh
qemu-system-arm -M versatilepb \
  -kernel zImage -dtb versatile-pb.dtb \
  -drive file=rootfs.ext2,if=sd,format=raw \
  -append "root=/dev/mmcblk0 console=ttyAMA0" \
  -device bmp280-sim,address=0x76,input=/tmp/bmp280_sim_input
```

If QEMU says there is no I²C bus to attach to, create the slave in the board file and keep the input path as a property only when the device is created with `qdev_new` / `-device`.

What the model implements:

- Pointer write, then auto-incrementing reads and writes (§5.2).
- `0xD0` id `0x58`, `0xE0` soft reset on `0xB6`, `0xF3` status, `0xF4` ctrl_meas, `0xF5` config.
- Pressure `0xF7..0xF9` and temperature `0xFA..0xFC`, 20-bit, XLSB in the top nibble.
- Calibration `0x88..0x9F` little-endian, the §3.12 sample coefficients. `0xA0..0xA1` left zero.
- Forced mode (`mode[1:0]` = 01 or 10) converts once and the bits fall back to sleep.
- Normal mode converts on `t_sb` from config.
- IIR coefficient from `filter[2:0]`. Writing a new filter clears its memory.
- Burst shadowing (§3.10): a conversion that finishes mid-read lands in a shadow and is committed on STOP.

SPI is not modeled. `spi3w_en` is stored and ignored.

```sh
./configure --target-list=arm-softmmu
make -j"$(nproc)"
```

## 3. Device probe

`firmware/dts/bmp280-versatile.dtsi` replaces the stock `i2c@10002000` node so the child exists before userspace starts.

```dts
i2c@10002000 {
    compatible = "arm,versatile-i2c";
    reg = <0x10002000 0x1000>;
    #address-cells = <1>;
    #size-cells = <0>;

    bmp280@76 {
        compatible = "bosch,bmp280";
        reg = <0x76>;
    };
};
```

The Versatile I²C driver walks OF children and registers an `i2c_client`. No board file and no `echo bmp280 0x76 > /sys/bus/i2c/devices/i2c-N/new_device` are required. That echo still works if the node is missing.

`reg` must equal the QEMU address. Anything else is a NACK. Probe returns `-ENODEV` or `-EIO`, and the scope stays empty.

The driver matches two tables:

- `of_device_id` compatible `"bosch,bmp280"`
- `i2c_device_id` `"bmp280"`

`bmp280_probe` then does this, in order:

1. Refuse the adapter unless it can do `I2C_FUNC_SMBUS_BYTE_DATA` and `I2C_FUNC_SMBUS_READ_I2C_BLOCK`.
2. Read `0xD0`. Anything other than `0x58` is `dev_err` and `-ENODEV`.
3. Allocate an IIO device (`devm_iio_device_alloc`).

On the bench, moving the device-tree `reg` off the SDO strap is the same failure: the trace says `No acknowledge`, `driverUp` stays false, and the scope has no driver series.

## 4. Driver initialization

Still inside `bmp280_probe`, after the id matches:

4. Burst-read 24 bytes at `0x88` into `dig_T1..T3` and `dig_P1..P9` (little-endian). `dig_T1 == 0` or `dig_P1 == 0` is an empty calibration image and returns `-EINVAL`.
5. Write `config` (`0xF5`) = `0x28`. Standby `t_sb` = 62.5 ms, IIR coefficient 4.
6. Write `ctrl_meas` (`0xF4`) = `0x57`. Normal mode, `osrs_t` ×2, `osrs_p` ×16. That is the datasheet "handheld low-power" row.
7. Register the IIO device, name `bmp280`, one processed temperature channel and one processed pressure channel.
8. `dev_info`: `BMP280 at 0x76, dig_T1=… dig_P1=…`.

```sh
cd firmware/kernel
make KDIR=/path/to/versatile/linux ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
# copy bmp280.ko into the rootfs and boot
insmod bmp280.ko
dmesg | grep BMP280
```

`remove` writes `ctrl_meas = 0x00` so the part is asleep when the module goes away. The IIO device itself is released by devm.

Buildroot (or the equivalent guest config) needs `CONFIG_I2C`, `CONFIG_I2C_VERSATILE`, `CONFIG_IIO`, and `CONFIG_I2C_CHARDEV` only if you also want `/dev/i2c-0`. The driver uses SMBus block transfers, not the character device.

## 5. Reading the value

Every sysfs read is one `bmp280_read_raw` call. Only `IIO_CHAN_INFO_PROCESSED` is implemented.

1. Take the driver mutex.
2. Read `0xF3`. Bit 3 (`measuring`) returns `-EAGAIN`. The conversion is still in progress.
3. Burst-read 6 bytes at `0xF7`. Pressure is bytes 0..2, temperature is bytes 3..5. Each sample is 20 bits: MSB, LSB, and the top nibble of XLSB.
4. `0x80000` means that channel was skipped (`osrs` = 0). The read returns `-ENODATA`.
5. Temperature first. The integer formula stores `t_fine` on the device struct. Pressure uses that `t_fine`, so a pressure read always compensates temperature even if userspace only asked for pressure.
6. Unlock, then publish.

IIO processed ABI:

```sh
cat /sys/bus/iio/devices/iio:device0/name                 # bmp280
cat /sys/bus/iio/devices/iio:device0/in_temp_input       # millidegree C, 25080 = 25.080 °C
cat /sys/bus/iio/devices/iio:device0/in_pressure_input   # kilopascal
```

Temperature is `t_centi * 10`, returned as `IIO_VAL_INT`.
Pressure is the Q24.8 result divided into kilopascal plus micro-units (`IIO_VAL_INT_PLUS_MICRO`). `100.653250` kPa is about 1006.53 hPa.

The §3.12 vector, checked by the self-test:

```sh
make -C firmware/selftest && firmware/selftest/selftest
```

Expect `all checks passed`, including `adc_T` 519888 → 25.08 °C / `t_fine` 128422, and `adc_P` 415148 → 25767233.

## 6. Scope output

Two scopes, same numbers.

**Browser bench.** From the repo root:

```sh
npm install
VITE_AUTH_ENABLED=false npm run dev
```

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/). The page is the six stages side by side: injected setpoint, raw registers, `t_fine`, the float trace from datasheet appendix 8.1, and the IIO strings.

On the chart:

- dashed lines are the stimulus (what you injected, or the live sine)
- solid lines are what the driver computed after compensation

Left axis is °C. Right axis is hPa. With noise off and the bench setpoint held still, the solid line meets the dashed line within the integer quantization of the 20-bit code. A mismatched `reg` drops the solid series. Soft reset (`0xB6` at `0xE0`) returns the part to sleep and the driver must probe again.

Production build of the same page:

```sh
VITE_AUTH_ENABLED=false npm run build
VITE_AUTH_ENABLED=false npm run preview
```

That preview listens on [http://127.0.0.1:8081/](http://127.0.0.1:8081/). `VITE_AUTH_ENABLED` must be `false` for both commands. Do not set `DATABASE_URL` while auth is disabled.

**Guest text scope.** Inside the booted Versatile rootfs:

```sh
python3 firmware/userspace/iio_watch.py
python3 firmware/userspace/iio_watch.py /sys/bus/iio/devices/iio:device0
```

Each line is one pair of sysfs reads, printed as millidegree Celsius and as kilopascal, plus the same numbers in °C and hPa. It polls every 250 ms. Point any plotter at those two files if you want a trace instead of text.

Changing `/tmp/bmp280_sim_input` on the **host** moves both the guest sysfs values and, if you set the same numbers on the bench, the solid trace. Both sides run §3.11.3.

## Suggested boot check

1. `firmware/selftest/selftest` prints `all checks passed` on the host.
2. Guest `dmesg` contains `BMP280 at 0x76`.
3. `in_temp_input` moves when `inject.py` writes a new temperature.
4. On the bench, with noise off and the setpoint held, the solid and dashed traces meet.
