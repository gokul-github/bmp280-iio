// SPDX-License-Identifier: GPL-2.0
/*
 * Bosch BMP280 I²C pressure and temperature sensor, IIO driver.
 *
 * Binds to compatible = "bosch,bmp280". This is a single-file lab driver
 * (probe, calibration, normal-mode configuration, burst read, integer
 * compensation from BST-BMP280-DS001-11 §3.11.3). Disable the in-tree
 * CONFIG_BMP280 so the two modules do not both claim that compatible.
 *
 * Userspace (IIO processed values):
 *   /sys/bus/iio/devices/iio:deviceX/in_temp_input      millidegree Celsius
 *   /sys/bus/iio/devices/iio:deviceX/in_pressure_input  kilopascal
 *
 * Out of tree:
 *   make -C /path/to/kernel M=$PWD ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
 */

#include <linux/i2c.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/of.h>
#include <linux/iio/iio.h>

#define BMP280_CHIP_ID 0x58

#define BMP280_REG_CALIB 0x88
#define BMP280_REG_ID 0xD0
#define BMP280_REG_RESET 0xE0
#define BMP280_REG_STATUS 0xF3
#define BMP280_REG_CTRL 0xF4
#define BMP280_REG_CONFIG 0xF5
#define BMP280_REG_PRESS 0xF7

/* Handheld low-power, datasheet table 7: osrs_t ×2, osrs_p ×16, normal. */
#define BMP280_CTRL_NORMAL 0x57
/* t_sb = 62.5 ms, IIR coefficient 4. */
#define BMP280_CONFIG_DEFAULT 0x28

struct bmp280_data {
	struct i2c_client *client;
	struct mutex lock;
	u16 dig_T1;
	s16 dig_T2, dig_T3;
	u16 dig_P1;
	s16 dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
	s32 t_fine;
};

static u16 bmp280_le16(const u8 *p)
{
	return (u16)p[0] | ((u16)p[1] << 8);
}

static int bmp280_read_id(struct i2c_client *client)
{
	int id = i2c_smbus_read_byte_data(client, BMP280_REG_ID);

	if (id < 0)
		return id;
	if (id != BMP280_CHIP_ID) {
		dev_err(&client->dev, "chip id 0x%02x is not BMP280 (0x58)\n", id);
		return -ENODEV;
	}
	return 0;
}

static int bmp280_read_calib(struct bmp280_data *data)
{
	u8 buf[24];
	int ret;
	struct i2c_client *client = data->client;

	ret = i2c_smbus_read_i2c_block_data(client, BMP280_REG_CALIB, sizeof(buf), buf);
	if (ret < 0)
		return ret;
	if (ret != sizeof(buf))
		return -EIO;

	data->dig_T1 = bmp280_le16(&buf[0]);
	data->dig_T2 = (s16)bmp280_le16(&buf[2]);
	data->dig_T3 = (s16)bmp280_le16(&buf[4]);
	data->dig_P1 = bmp280_le16(&buf[6]);
	data->dig_P2 = (s16)bmp280_le16(&buf[8]);
	data->dig_P3 = (s16)bmp280_le16(&buf[10]);
	data->dig_P4 = (s16)bmp280_le16(&buf[12]);
	data->dig_P5 = (s16)bmp280_le16(&buf[14]);
	data->dig_P6 = (s16)bmp280_le16(&buf[16]);
	data->dig_P7 = (s16)bmp280_le16(&buf[18]);
	data->dig_P8 = (s16)bmp280_le16(&buf[20]);
	data->dig_P9 = (s16)bmp280_le16(&buf[22]);

	if (data->dig_T1 == 0 || data->dig_P1 == 0) {
		dev_err(&client->dev, "calibration image is empty\n");
		return -EINVAL;
	}
	return 0;
}

/* Returns 0.01 °C. t_fine is stored on data for the pressure formula. */
static s32 bmp280_compensate_temp(struct bmp280_data *data, s32 adc_T)
{
	s32 var1, var2;

	var1 = ((((adc_T >> 3) - ((s32)data->dig_T1 << 1))) * (s32)data->dig_T2) >> 11;
	var2 = (((((adc_T >> 4) - (s32)data->dig_T1) *
		  ((adc_T >> 4) - (s32)data->dig_T1)) >> 12) *
		(s32)data->dig_T3) >> 14;
	data->t_fine = var1 + var2;
	return (data->t_fine * 5 + 128) >> 8;
}

/* Q24.8 pascals. */
static u32 bmp280_compensate_press(struct bmp280_data *data, s32 adc_P)
{
	s64 var1, var2, p;

	var1 = ((s64)data->t_fine) - 128000;
	var2 = var1 * var1 * (s64)data->dig_P6;
	var2 = var2 + ((var1 * (s64)data->dig_P5) << 17);
	var2 = var2 + (((s64)data->dig_P4) << 35);
	var1 = ((var1 * var1 * (s64)data->dig_P3) >> 8) +
	       ((var1 * (s64)data->dig_P2) << 12);
	var1 = (((((s64)1) << 47) + var1) * ((s64)data->dig_P1)) >> 33;
	if (var1 == 0)
		return 0;
	p = 1048576 - (s64)adc_P;
	p = (((p << 31) - var2) * 3125) / var1;
	var1 = (((s64)data->dig_P9) * (p >> 13) * (p >> 13)) >> 25;
	var2 = (((s64)data->dig_P8) * p) >> 19;
	p = ((p + var1 + var2) >> 8) + (((s64)data->dig_P7) << 4);
	return (u32)p;
}

static int bmp280_burst(struct bmp280_data *data, s32 *adc_t, s32 *adc_p)
{
	u8 buf[6];
	int ret, status;
	struct i2c_client *client = data->client;

	status = i2c_smbus_read_byte_data(client, BMP280_REG_STATUS);
	if (status < 0)
		return status;
	if (status & 0x08)
		return -EAGAIN;

	ret = i2c_smbus_read_i2c_block_data(client, BMP280_REG_PRESS, sizeof(buf), buf);
	if (ret < 0)
		return ret;
	if (ret != sizeof(buf))
		return -EIO;

	*adc_p = (buf[0] << 12) | (buf[1] << 4) | (buf[2] >> 4);
	*adc_t = (buf[3] << 12) | (buf[4] << 4) | (buf[5] >> 4);
	return 0;
}

static int bmp280_read_raw(struct iio_dev *indio_dev,
			   struct iio_chan_spec const *chan,
			   int *val, int *val2, long mask)
{
	struct bmp280_data *data = iio_priv(indio_dev);
	s32 adc_t, adc_p, t_centi;
	u32 q;
	int ret;

	if (mask != IIO_CHAN_INFO_PROCESSED)
		return -EINVAL;

	mutex_lock(&data->lock);
	ret = bmp280_burst(data, &adc_t, &adc_p);
	if (ret) {
		mutex_unlock(&data->lock);
		return ret;
	}

	if (chan->type == IIO_TEMP) {
		if (adc_t == 0x80000) {
			mutex_unlock(&data->lock);
			return -ENODATA;
		}
		t_centi = bmp280_compensate_temp(data, adc_t);
		mutex_unlock(&data->lock);
		/* IIO ABI: millidegree Celsius. */
		*val = t_centi * 10;
		return IIO_VAL_INT;
	}

	if (chan->type == IIO_PRESSURE) {
		if (adc_t == 0x80000 || adc_p == 0x80000) {
			mutex_unlock(&data->lock);
			return -ENODATA;
		}
		bmp280_compensate_temp(data, adc_t);
		q = bmp280_compensate_press(data, adc_p);
		mutex_unlock(&data->lock);
		/* IIO ABI: kilopascal, as integer + micro. */
		*val = q / 256000;
		*val2 = (int)(((u64)(q % 256000) * 1000000ULL) / 256000ULL);
		return IIO_VAL_INT_PLUS_MICRO;
	}

	mutex_unlock(&data->lock);
	return -EINVAL;
}

static const struct iio_info bmp280_info = {
	.read_raw = bmp280_read_raw,
};

static const struct iio_chan_spec bmp280_channels[] = {
	{
		.type = IIO_TEMP,
		.info_mask_separate = BIT(IIO_CHAN_INFO_PROCESSED),
	},
	{
		.type = IIO_PRESSURE,
		.info_mask_separate = BIT(IIO_CHAN_INFO_PROCESSED),
	},
};

static int bmp280_probe(struct i2c_client *client)
{
	struct iio_dev *indio_dev;
	struct bmp280_data *data;
	int ret;

	if (!i2c_check_functionality(client->adapter,
				     I2C_FUNC_SMBUS_BYTE_DATA |
				     I2C_FUNC_SMBUS_READ_I2C_BLOCK))
		return -EOPNOTSUPP;

	ret = bmp280_read_id(client);
	if (ret)
		return ret;

	indio_dev = devm_iio_device_alloc(&client->dev, sizeof(*data));
	if (!indio_dev)
		return -ENOMEM;

	data = iio_priv(indio_dev);
	data->client = client;
	mutex_init(&data->lock);
	i2c_set_clientdata(client, indio_dev);

	ret = bmp280_read_calib(data);
	if (ret)
		return ret;

	ret = i2c_smbus_write_byte_data(client, BMP280_REG_CONFIG, BMP280_CONFIG_DEFAULT);
	if (ret < 0)
		return ret;
	ret = i2c_smbus_write_byte_data(client, BMP280_REG_CTRL, BMP280_CTRL_NORMAL);
	if (ret < 0)
		return ret;

	indio_dev->name = "bmp280";
	indio_dev->modes = INDIO_DIRECT_MODE;
	indio_dev->channels = bmp280_channels;
	indio_dev->num_channels = ARRAY_SIZE(bmp280_channels);
	indio_dev->info = &bmp280_info;

	ret = devm_iio_device_register(&client->dev, indio_dev);
	if (ret)
		return ret;

	dev_info(&client->dev, "BMP280 at 0x%02x, dig_T1=%u dig_P1=%u\n",
		 client->addr, data->dig_T1, data->dig_P1);
	return 0;
}

static void bmp280_remove(struct i2c_client *client)
{
	/* devm_ unregisters the IIO device. Leave the sensor asleep. */
	i2c_smbus_write_byte_data(client, BMP280_REG_CTRL, 0x00);
}

static const struct of_device_id bmp280_of_match[] = {
	{ .compatible = "bosch,bmp280" },
	{ }
};
MODULE_DEVICE_TABLE(of, bmp280_of_match);

static const struct i2c_device_id bmp280_id[] = {
	{ "bmp280", 0 },
	{ }
};
MODULE_DEVICE_TABLE(i2c, bmp280_id);

static struct i2c_driver bmp280_driver = {
	.driver = {
		.name = "bmp280",
		.of_match_table = bmp280_of_match,
	},
	.probe = bmp280_probe,
	.remove = bmp280_remove,
	.id_table = bmp280_id,
};
module_i2c_driver(bmp280_driver);

MODULE_AUTHOR("BMP280 lab");
MODULE_DESCRIPTION("Bosch BMP280 I2C pressure sensor (IIO)");
MODULE_LICENSE("GPL");
