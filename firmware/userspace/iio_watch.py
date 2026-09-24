#!/usr/bin/env python3
"""Poll the BMP280 IIO sysfs nodes inside the guest and print them.

    iio_watch.py
    iio_watch.py /sys/bus/iio/devices/iio:device0

Temperature is millidegree Celsius. Pressure is kilopascal.
"""

import sys
import time
from pathlib import Path

def main() -> int:
    base = Path(sys.argv[1] if len(sys.argv) > 1 else "/sys/bus/iio/devices/iio:device0")
    temp = base / "in_temp_input"
    press = base / "in_pressure_input"
    if not temp.exists():
        print(f"missing {temp}", file=sys.stderr)
        return 1
    while True:
        t_raw = temp.read_text().strip()
        p_raw = press.read_text().strip() if press.exists() else "n/a"
        try:
            t_c = int(t_raw) / 1000.0
            t_show = f"{t_c:.3f} °C"
        except ValueError:
            t_show = t_raw
        try:
            p_hpa = float(p_raw) * 10.0
            p_show = f"{p_hpa:.3f} hPa"
        except ValueError:
            p_show = p_raw
        print(f"in_temp_input={t_raw} ({t_show})  in_pressure_input={p_raw} ({p_show})")
        time.sleep(0.25)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
