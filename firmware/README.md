# Firmware tree

The pipeline walkthrough — stimulus, QEMU slave, probe, driver init, sysfs read, and scope — is in the [repository README](../README.md).

| Path | Role |
| --- | --- |
| `qemu/bmp280_sim.c` | I²C slave, type `bmp280-sim`, address 0x76 |
| `qemu/bmp280_math.h` | §3.11.3 compensation and the inverse used to encode a setpoint |
| `kernel/bmp280.c` | out-of-tree IIO driver, compatible `bosch,bmp280` |
| `dts/bmp280-versatile.dtsi` | Versatile/PB I²C node, `reg = <0x76>` |
| `userspace/inject.py` | write `°C hPa` or `LIVE` into `/tmp/bmp280_sim_input` |
| `userspace/iio_watch.py` | poll `in_temp_input` and `in_pressure_input` |
| `selftest/` | host check of the §3.12 vector (`make && ./selftest`) |

Quick check, no QEMU and no kernel:

```sh
make -C firmware/selftest && firmware/selftest/selftest
```
