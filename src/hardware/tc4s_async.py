import asyncio
import crcmod
from datetime import datetime


try:
    import serial_asyncio_fast as serial_asyncio
except ImportError:
    import serial_asyncio


class AsyncTC4SCommunicator:
    """异步TC4S通讯核心类"""

    def __init__(self, port='/dev/ttyUSB0', baudrate=9600, slave_id=1):
        self.port = port
        self.baudrate = baudrate
        self.slave_id = slave_id
        self.reader = None
        self.writer = None
        self.connected = False

        # 寄存器地址
        self.registers = {
            'sv': 0x0002,
            'pv': 0x0000,
        }

        # CRC计算
        self.crc16 = crcmod.predefined.mkCrcFun('modbus')

        # 异步任务控制
        self._stop_event = asyncio.Event()
        self._monitor_task = None
        self._data_callbacks = []

        # 写入互斥锁
        self._write_lock = asyncio.Lock()

        # 状态回调
        self._status_callbacks = []

    async def connect(self) -> bool:
        """连接串口"""
        try:
            self.reader, self.writer = await serial_asyncio.open_serial_connection(
                url=self.port,
                baudrate=self.baudrate,
                bytesize=serial_asyncio.serial.EIGHTBITS,
                parity=serial_asyncio.serial.PARITY_NONE,
                stopbits=serial_asyncio.serial.STOPBITS_ONE,
            )
            self.connected = True
            return True
        except Exception as e:
            print(f"连接失败: {e}")
            return False

    async def disconnect(self):
        """断开连接"""
        self.connected = False
        self._stop_event.set()
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except asyncio.CancelledError:
                pass
            self._monitor_task = None
        if self.writer:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except Exception:
                pass
            self.writer = None
            self.reader = None

    def calculate_crc(self, data: bytes) -> bytes:
        """计算CRC"""
        crc = self.crc16(data)
        return crc.to_bytes(2, byteorder='little')

    def register_status_callback(self, callback):
        self._status_callbacks.append(callback)

    def unregister_status_callback(self, callback):
        if callback in self._status_callbacks:
            self._status_callbacks.remove(callback)

    def _notify_status(self, status: str, reason: str = ""):
        for cb in self._status_callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    asyncio.create_task(cb(status, reason))
                else:
                    cb(status, reason)
            except Exception:
                pass

    async def _flush_input_buffer(self):
        """清空输入缓冲"""
        while True:
            try:
                discard = await asyncio.wait_for(self.reader.read(1024), timeout=0.01)
                if not discard:
                    break
            except asyncio.TimeoutError:
                break

    async def send_command(self, data: bytes):
        """发送命令（带指数退避重试，最多3次）"""
        if not self.connected or not self.writer:
            return None

        delays = [0.0, 0.05, 0.15, 0.45]

        for attempt in range(1, 4):
            try:
                async with self._write_lock:
                    # 每次重试前清空输入缓冲
                    await self._flush_input_buffer()

                    self.writer.write(data)
                    await self.writer.drain()
                    await asyncio.sleep(0.05)
                    response = await asyncio.wait_for(self.reader.read(100), timeout=0.5)

                if response:
                    return response
            except Exception as e:
                print(f"发送错误 (尝试 {attempt}/3): {e}")

            # 等待后重试
            if attempt < 3:
                await asyncio.sleep(delays[attempt])

        print("发送命令失败，3次重试均失败")
        return None

    async def read_register(self, register: int, count: int = 1):
        """读取寄存器"""
        request = bytearray()
        request.append(self.slave_id)
        request.append(0x03)
        request.append((register >> 8) & 0xFF)
        request.append(register & 0xFF)
        request.append((count >> 8) & 0xFF)
        request.append(count & 0xFF)

        crc = self.calculate_crc(request)
        request.extend(crc)

        response = await self.send_command(bytes(request))

        if not response or len(response) < 5:
            return None

        # 验证CRC
        received_crc = response[-2:]
        calculated_crc = self.calculate_crc(response[:-2])

        if received_crc != calculated_crc:
            self._notify_status("error", f"CRC校验失败，寄存器0x{register:04x}")
            return None

        # 提取数据
        byte_count = response[2]
        data_bytes = response[3:-2]

        if byte_count != len(data_bytes):
            return None

        return data_bytes

    async def write_register(self, register: int, value: int) -> bool:
        """写入寄存器"""
        request = bytearray()
        request.append(self.slave_id)
        request.append(0x06)
        request.append((register >> 8) & 0xFF)
        request.append(register & 0xFF)
        request.append((value >> 8) & 0xFF)
        request.append(value & 0xFF)

        crc = self.calculate_crc(request)
        request.extend(crc)

        response = await self.send_command(bytes(request))

        if not response or len(response) != len(request):
            return False

        return response == request

    async def read_pv(self, addr=0x0000):
        """读取当前温度"""
        data = await self.read_register(addr, 1)
        if data and len(data) == 2:
            value = (data[0] << 8) | data[1]
            return float(value)
        return None

    async def read_sv(self):
        """读取设定温度"""
        data = await self.read_register(self.registers['sv'], 1)
        if data and len(data) == 2:
            value = (data[0] << 8) | data[1]
            return float(value)
        return None

    async def set_sv(self, temperature: float) -> bool:
        """设置目标温度"""
        try:
            temp_int = int(temperature)
            success = await self.write_register(self.registers['sv'], temp_int)
            return success
        except Exception:
            return False

    async def auto_find_pv_address(self):
        """自动寻找PV地址"""
        print("自动寻找PV地址...")
        for addr in [0x0000, 0x0001, 0x0100, 0x0101, 0x1000, 0x1001, 0x2000, 0x2001]:
            data = await self.read_register(addr, 1)
            if data and len(data) == 2:
                value = (data[0] << 8) | data[1]
                if 0 <= value <= 300:
                    self.registers['pv'] = addr
                    print(f"找到PV地址: 0x{addr:04x}, 值: {value}")
                    return addr, float(value)
        return None, None

    async def get_all_data(self):
        """获取所有数据"""
        pv = await self.read_pv(self.registers['pv'])
        if pv is None:
            addr, value = await self.auto_find_pv_address()
            if addr is not None:
                pv = value

        sv = await self.read_sv()

        data = {
            'pv': pv,
            'sv': sv,
            'timestamp': datetime.now().isoformat(),
        }
        return data

    def register_callback(self, callback):
        self._data_callbacks.append(callback)

    def unregister_callback(self, callback):
        if callback in self._data_callbacks:
            self._data_callbacks.remove(callback)

    async def start_monitoring(self, interval: float = 1.0):
        """开始监控"""
        if self._monitor_task and not self._monitor_task.done():
            return
        self._stop_event.clear()
        self._monitor_task = asyncio.create_task(self._monitor_loop(interval))

    async def stop_monitoring(self):
        """停止监控"""
        self._stop_event.set()
        if self._monitor_task:
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except asyncio.CancelledError:
                pass
            self._monitor_task = None

    async def _reconnect_loop(self):
        """重连循环（带最大重试次数和指数退避）"""
        max_retries = 30
        base_delay = 2.0
        max_delay = 30.0

        for attempt in range(1, max_retries + 1):
            if self._stop_event.is_set():
                return

            print(f"尝试重连... ({attempt}/{max_retries})")
            try:
                success = await self.connect()
                if success:
                    # 重连成功后重新寻找PV地址
                    await self.auto_find_pv_address()
                    self._notify_status("connected", "")
                    await self.start_monitoring()
                    return
            except Exception as e:
                print(f"重连失败: {e}")

            if attempt >= max_retries:
                break

            # 指数退避：2s, 4s, 8s, 16s, 30s, 30s...
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        # 达到最大重试次数，停止重连
        self.connected = False
        self._notify_status("disconnected", "重连失败，已达到最大重试次数")

    async def _monitor_loop(self, interval: float):
        """监控循环"""
        consecutive_failures = 0
        while not self._stop_event.is_set() and self.connected:
            try:
                data = await self.get_all_data()
                if data['pv'] is None or data['sv'] is None:
                    consecutive_failures += 1
                    if consecutive_failures >= 3:
                        self.connected = False
                        self._notify_status("disconnected", "连续通信失败")
                        asyncio.create_task(self._reconnect_loop())
                        return
                else:
                    consecutive_failures = 0
                    for cb in self._data_callbacks:
                        try:
                            if asyncio.iscoroutinefunction(cb):
                                asyncio.create_task(cb(data))
                            else:
                                cb(data)
                        except Exception as e:
                            print(f"数据回调异常: {e}")

                # 等待 interval 或停止信号
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    pass
            except Exception as e:
                print(f"监控错误: {e}")
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    pass
