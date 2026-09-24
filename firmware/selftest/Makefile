CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -std=c11

.PHONY: all clean
all: selftest

selftest: selftest.c ../qemu/bmp280_math.h
	$(CC) $(CFLAGS) -o $@ selftest.c -lm

clean:
	rm -f selftest
