# Out-of-tree build. ARCH and CROSS_COMPILE, when passed on the command
# line, are forwarded by GNU make automatically.
#   make KDIR=/path/to/linux ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
obj-m += bmp280.o

KDIR ?= /lib/modules/$(shell uname -r)/build

all:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules

clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean
