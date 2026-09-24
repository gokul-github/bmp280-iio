#!/usr/bin/env python3
"""Stage-1 injector for the QEMU BMP280 model.

Writes one line into the host file the device polls (default
/tmp/bmp280_sim_input). Temperature is degrees Celsius, pressure is hPa.

    inject.py 25.4
    inject.py 25.4 1013.25
    inject.py --live
    inject.py --repl
"""

import argparse
import sys

DEFAULT_PATH = "/tmp/bmp280_sim_input"


def write(path: str, line: str) -> None:
    with open(path, "w", encoding="ascii") as fh:
        fh.write(line.rstrip() + "\n")
    print(f"wrote {line.rstrip()!r} -> {path}")


def main() -> int:
    p = argparse.ArgumentParser(description="Inject a BMP280 stimulus")
    p.add_argument("temp", nargs="?", type=float, help="temperature °C")
    p.add_argument("press", nargs="?", type=float, help="pressure hPa")
    p.add_argument("--path", default=DEFAULT_PATH)
    p.add_argument("--live", action="store_true", help="return the model to sine+noise")
    p.add_argument("--repl", action="store_true", help="read 'T P' lines from stdin")
    args = p.parse_args()

    if args.live:
        write(args.path, "LIVE")
        return 0
    if args.repl or args.temp is None:
        print("enter '<°C> [hPa]' or LIVE, blank line to quit")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                break
            write(args.path, line)
        return 0
    if args.press is None:
        write(args.path, f"{args.temp:.4f}")
    else:
        write(args.path, f"{args.temp:.4f} {args.press:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
