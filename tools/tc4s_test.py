#!/usr/bin/env python3
"""
TC4S温度控制器通讯程序（修正版）
问题修正：
1. PV已经是实际温度值，不需要除以10
2. SV是200，直接就是200°C
"""

import serial
import time
import struct
import crcmod
import threading
from queue import Queue
from datetime import datetime
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import json
import os

class TC4S_Communicator:
    """TC4S通讯核心类"""

    def __init__(self, port='/dev/ttyUSB0', baudrate=9600, slave_id=1):
        self.port = port
        self.baudrate = baudrate
        self.slave_id = slave_id
        self.serial = None
        self.connected = False

        # 寄存器地址 - 根据您的测试结果
        self.registers = {
            'sv': 0x0002,      # 设定温度 - 确认正确，值200就是200°C
            'pv': 0x0000,      # 当前温度 - 需要寻找正确地址
        }

        # 数据缓存
        self.current_temp = 0.0
        self.target_temp = 0.0

        # 通讯线程
        self.running = False
        self.monitor_thread = None
        self.data_queue = Queue()

        # CRC计算
        self.crc16 = crcmod.predefined.mkCrcFun('modbus')

    def connect(self):
        """连接串口"""
        try:
            self.serial = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.5,
                write_timeout=0.5
            )

            self.connected = True
            return True

        except Exception as e:
            print(f"连接失败: {e}")
            return False

    def disconnect(self):
        """断开连接"""
        self.connected = False
        if self.serial and self.serial.is_open:
            self.serial.close()

    def calculate_crc(self, data):
        """计算CRC"""
        crc = self.crc16(data)
        return crc.to_bytes(2, byteorder='little')

    def send_command(self, data):
        """发送命令"""
        if not self.connected or not self.serial:
            return None

        try:
            self.serial.reset_input_buffer()
            self.serial.write(data)
            self.serial.flush()

            time.sleep(0.05)
            response = self.serial.read(100)

            return response if response else None

        except Exception as e:
            print(f"发送错误: {e}")
            return None

    def read_register(self, register, count=1):
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

        response = self.send_command(request)

        if not response or len(response) < 5:
            return None

        # 验证CRC
        received_crc = response[-2:]
        calculated_crc = self.calculate_crc(response[:-2])

        if received_crc != calculated_crc:
            return None

        # 提取数据
        byte_count = response[2]
        data_bytes = response[3:-2]

        if byte_count != len(data_bytes):
            return None

        return data_bytes

    def write_register(self, register, value):
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

        response = self.send_command(request)

        if not response or len(response) != len(request):
            return False

        return response == request

    def read_pv(self, addr=0x0000):
        """读取当前温度 - 修正版本，不除以10"""
        data = self.read_register(addr, 1)
        if data and len(data) == 2:
            # 直接使用原始值，不除以10
            value = (data[0] << 8) | data[1]
            return float(value)
        return None

    def read_sv(self):
        """读取设定温度"""
        data = self.read_register(self.registers['sv'], 1)
        if data and len(data) == 2:
            value = (data[0] << 8) | data[1]
            return float(value)  # 直接返回，200就是200°C
        return None

    def set_sv(self, temperature):
        """设置目标温度"""
        try:
            temp_int = int(temperature)
            success = self.write_register(self.registers['sv'], temp_int)
            return success
        except:
            return False

    def auto_find_pv_address(self):
        """自动寻找PV地址"""
        print("自动寻找PV地址...")
        for addr in [0x0000, 0x0001, 0x0100, 0x0101, 0x1000, 0x1001, 0x2000, 0x2001]:
            data = self.read_register(addr, 1)
            if data and len(data) == 2:
                value = (data[0] << 8) | data[1]
                # 检查是否是合理的温度值（0-300）
                if 0 <= value <= 300:
                    self.registers['pv'] = addr
                    print(f"找到PV地址: 0x{addr:04x}, 值: {value}")
                    return addr, value
        return None, None

    def get_all_data(self):
        """获取所有数据"""
        # 先尝试读取PV
        pv = self.read_pv(self.registers['pv'])
        if pv is None:
            # 如果读取失败，尝试自动寻找
            addr, value = self.auto_find_pv_address()
            if addr is not None:
                pv = value

        sv = self.read_sv()

        data = {
            'pv': pv,
            'sv': sv,
            'timestamp': datetime.now().strftime("%H:%M:%S")
        }

        if pv is not None:
            self.current_temp = pv
        if sv is not None:
            self.target_temp = sv

        return data

    def start_monitoring(self, interval=1.0):
        """开始监控"""
        if self.running:
            return

        self.running = True
        self.monitor_thread = threading.Thread(
            target=self._monitor_loop,
            args=(interval,),
            daemon=True
        )
        self.monitor_thread.start()

    def stop_monitoring(self):
        """停止监控"""
        self.running = False
        if self.monitor_thread:
            self.monitor_thread.join(timeout=2.0)

    def _monitor_loop(self, interval):
        """监控循环"""
        while self.running and self.connected:
            try:
                data = self.get_all_data()
                if data['pv'] is not None and data['sv'] is not None:
                    self.data_queue.put(data)

                time.sleep(interval)

            except Exception as e:
                print(f"监控错误: {e}")
                time.sleep(interval)


class TC4S_GUI:
    """TC4S图形界面"""

    def __init__(self, master):
        self.master = master
        master.title("TC4S温度控制器 v2.1")
        master.geometry("600x500")

        # 设置图标
        try:
            master.iconbitmap('default.ico')
        except:
            pass

        # 初始化通讯器
        self.comm = TC4S_Communicator()
        self.monitoring = False

        # 创建主框架
        self.create_widgets()

        # 加载配置
        self.load_config()

        # 启动时尝试自动连接
        self.after_id = master.after(100, self.auto_connect)

    def create_widgets(self):
        """创建界面组件"""
        # 顶部控制栏
        control_frame = ttk.Frame(self.master, padding="10")
        control_frame.grid(row=0, column=0, sticky=(tk.W, tk.E))

        # 串口设置
        ttk.Label(control_frame, text="串口:").grid(row=0, column=0, padx=(0,5))
        self.port_var = tk.StringVar(value='/dev/ttyUSB0')
        self.port_combo = ttk.Combobox(control_frame, textvariable=self.port_var,
                                      values=['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0'], width=12)
        self.port_combo.grid(row=0, column=1, padx=(0,10))

        ttk.Label(control_frame, text="波特率:").grid(row=0, column=2, padx=(0,5))
        self.baud_var = tk.StringVar(value='9600')
        self.baud_combo = ttk.Combobox(control_frame, textvariable=self.baud_var,
                                      values=['9600', '19200', '38400', '57600', '115200'], width=8)
        self.baud_combo.grid(row=0, column=3, padx=(0,10))

        ttk.Label(control_frame, text="地址:").grid(row=0, column=4, padx=(0,5))
        self.addr_var = tk.StringVar(value='1')
        self.addr_spin = ttk.Spinbox(control_frame, from_=1, to=247, textvariable=self.addr_var, width=5)
        self.addr_spin.grid(row=0, column=5, padx=(0,10))

        self.connect_btn = ttk.Button(control_frame, text="连接", command=self.toggle_connect, width=8)
        self.connect_btn.grid(row=0, column=6, padx=(10,5))

        # 温度显示区域
        temp_frame = ttk.Frame(self.master, padding="10")
        temp_frame.grid(row=1, column=0, padx=10, pady=5, sticky=(tk.W, tk.E, tk.N, tk.S))

        # 当前温度
        pv_frame = ttk.LabelFrame(temp_frame, text="当前温度 (PV)", padding="10")
        pv_frame.grid(row=0, column=0, padx=5, pady=5, sticky=(tk.W, tk.E))

        self.pv_label = ttk.Label(pv_frame, text="--", font=('Arial', 36, 'bold'), foreground='blue')
        self.pv_label.pack()
        ttk.Label(pv_frame, text="°C", font=('Arial', 16)).pack(side=tk.RIGHT, padx=5)

        # 目标温度
        sv_frame = ttk.LabelFrame(temp_frame, text="目标温度 (SV)", padding="10")
        sv_frame.grid(row=0, column=1, padx=5, pady=5, sticky=(tk.W, tk.E))

        self.sv_label = ttk.Label(sv_frame, text="--", font=('Arial', 36, 'bold'), foreground='red')
        self.sv_label.pack()
        ttk.Label(sv_frame, text="°C", font=('Arial', 16)).pack(side=tk.RIGHT, padx=5)

        # 温差
        diff_frame = ttk.LabelFrame(temp_frame, text="温差", padding="10")
        diff_frame.grid(row=0, column=2, padx=5, pady=5, sticky=(tk.W, tk.E))

        self.diff_label = ttk.Label(diff_frame, text="--", font=('Arial', 24))
        self.diff_label.pack()
        ttk.Label(diff_frame, text="°C", font=('Arial', 12)).pack(side=tk.RIGHT, padx=5)

        # 温度控制
        control_frame2 = ttk.LabelFrame(self.master, text="温度控制", padding="15")
        control_frame2.grid(row=2, column=0, padx=10, pady=5, sticky=(tk.W, tk.E))

        ttk.Label(control_frame2, text="设定温度:").grid(row=0, column=0, padx=(0,10))

        self.temp_var = tk.StringVar(value="200")
        self.temp_spin = ttk.Spinbox(control_frame2, from_=0, to=300, textvariable=self.temp_var, width=10)
        self.temp_spin.grid(row=0, column=1, padx=(0,10))
        ttk.Label(control_frame2, text="°C").grid(row=0, column=2, padx=(0,20))

        self.set_btn = ttk.Button(control_frame2, text="设定", command=self.set_temperature, state='disabled', width=8)
        self.set_btn.grid(row=0, column=3, padx=(0,10))

        # 温度调节按钮
        self.inc_btn = ttk.Button(control_frame2, text="+5°C", width=8,
                                 command=lambda: self.adjust_temp(5), state='disabled')
        self.inc_btn.grid(row=0, column=4, padx=2)

        self.dec_btn = ttk.Button(control_frame2, text="-5°C", width=8,
                                 command=lambda: self.adjust_temp(-5), state='disabled')
        self.dec_btn.grid(row=0, column=5, padx=2)

        # 监控控制
        monitor_frame = ttk.Frame(control_frame2)
        monitor_frame.grid(row=1, column=0, columnspan=6, pady=(15,0))

        self.monitor_btn = ttk.Button(monitor_frame, text="开始监控",
                                     command=self.toggle_monitor, state='disabled', width=10)
        self.monitor_btn.pack(side=tk.LEFT, padx=5)

        ttk.Label(monitor_frame, text="间隔:").pack(side=tk.LEFT, padx=(20,5))
        self.interval_var = tk.StringVar(value="1.0")
        self.interval_combo = ttk.Combobox(monitor_frame, textvariable=self.interval_var,
                                           values=['0.5', '1.0', '2.0', '5.0'], width=6)
        self.interval_combo.pack(side=tk.LEFT, padx=(0,5))
        ttk.Label(monitor_frame, text="秒").pack(side=tk.LEFT)

        # 状态信息
        status_frame = ttk.LabelFrame(self.master, text="状态信息", padding="10")
        status_frame.grid(row=3, column=0, padx=10, pady=10, sticky=(tk.W, tk.E, tk.S))

        self.status_text = scrolledtext.ScrolledText(status_frame, height=8, width=70)
        self.status_text.pack(fill=tk.BOTH, expand=True)

        # 底部按钮
        button_frame = ttk.Frame(self.master)
        button_frame.grid(row=4, column=0, pady=5)

        ttk.Button(button_frame, text="手动刷新", command=self.refresh_data, width=10).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="寻找PV地址", command=self.find_pv_address, width=10).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="清空日志", command=self.clear_log, width=10).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="退出", command=self.on_closing, width=10).pack(side=tk.LEFT, padx=5)

        # 配置网格权重
        self.master.columnconfigure(0, weight=1)

    def auto_connect(self):
        """自动连接"""
        if self.try_connect():
            self.log("自动连接成功")
        else:
            self.log("自动连接失败，请手动连接")

    def try_connect(self):
        """尝试连接"""
        try:
            self.comm.port = self.port_var.get()
            self.comm.baudrate = int(self.baud_var.get())
            self.comm.slave_id = int(self.addr_var.get())

            if self.comm.connect():
                self.connect_btn.configure(text="断开")
                self.set_btn.configure(state='normal')
                self.inc_btn.configure(state='normal')
                self.dec_btn.configure(state='normal')
                self.monitor_btn.configure(state='normal')
                self.log(f"已连接到 {self.comm.port}")

                # 立即读取一次数据
                self.refresh_data()
                return True
            else:
                self.log("连接失败")
                return False

        except Exception as e:
            self.log(f"连接错误: {e}")
            return False

    def toggle_connect(self):
        """连接/断开切换"""
        if self.comm.connected:
            if self.monitoring:
                self.toggle_monitor()

            self.comm.disconnect()
            self.connect_btn.configure(text="连接")
            self.set_btn.configure(state='disabled')
            self.inc_btn.configure(state='disabled')
            self.dec_btn.configure(state='disabled')
            self.monitor_btn.configure(state='disabled')
            self.log("已断开连接")
        else:
            if self.try_connect():
                # 自动寻找PV地址
                self.find_pv_address()

    def find_pv_address(self):
        """寻找PV地址"""
        if not self.comm.connected:
            self.log("请先连接设备")
            return

        self.log("正在寻找PV地址...")
        addr, value = self.comm.auto_find_pv_address()

        if addr is not None:
            self.log(f"找到PV地址: 0x{addr:04x}, 当前温度: {value}°C")
            # 刷新显示
            self.refresh_data()
        else:
            self.log("未找到PV地址，尝试手动寻找")
            # 尝试其他地址
            for test_addr in [0x0000, 0x0001, 0x0002, 0x0003, 0x0100, 0x0101]:
                temp = self.comm.read_pv(test_addr)
                if temp is not None and 0 <= temp <= 300:
                    self.log(f"测试地址 0x{test_addr:04x}: {temp}°C")

    def refresh_data(self):
        """刷新数据"""
        if not self.comm.connected:
            return

        try:
            data = self.comm.get_all_data()

            if data['pv'] is not None:
                self.pv_label.configure(text=f"{data['pv']:.1f}")

            if data['sv'] is not None:
                self.sv_label.configure(text=f"{data['sv']:.0f}")
                self.temp_var.set(str(data['sv']))

            # 计算温差
            if data['pv'] is not None and data['sv'] is not None:
                diff = data['pv'] - data['sv']
                diff_text = f"{diff:+.1f}"
                self.diff_label.configure(text=diff_text)

                # 根据温差设置颜色
                diff_abs = abs(diff)
                if diff_abs < 2:
                    self.diff_label.configure(foreground='green')
                elif diff_abs < 5:
                    self.diff_label.configure(foreground='orange')
                else:
                    self.diff_label.configure(foreground='red')

        except Exception as e:
            self.log(f"读取数据错误: {e}")

    def set_temperature(self):
        """设置温度"""
        if not self.comm.connected:
            return

        try:
            temp = float(self.temp_var.get())
            if 0 <= temp <= 300:
                if self.comm.set_sv(temp):
                    self.log(f"设置目标温度: {temp}°C")
                    # 刷新显示
                    self.refresh_data()
                else:
                    self.log("设置失败，请检查连接")
            else:
                self.log("温度范围错误 (0-300°C)")
        except ValueError:
            self.log("请输入有效的数字")

    def adjust_temp(self, delta):
        """调整温度"""
        try:
            current = float(self.temp_var.get())
            new_temp = current + delta
            if 0 <= new_temp <= 300:
                self.temp_var.set(str(int(new_temp)))  # 保持整数
                self.set_temperature()
        except:
            pass

    def toggle_monitor(self):
        """切换监控状态"""
        if not self.comm.connected:
            return

        if self.monitoring:
            self.comm.stop_monitoring()
            self.monitor_btn.configure(text="开始监控")
            self.monitoring = False
            self.log("停止监控")
        else:
            self.start_monitoring()
            self.monitor_btn.configure(text="停止监控")
            self.monitoring = True
            self.log("开始监控")

    def start_monitoring(self):
        """开始监控"""
        try:
            interval = float(self.interval_var.get())
            self.comm.start_monitoring(interval)
            self.master.after(100, self.update_monitor)
        except ValueError:
            self.log("间隔时间错误")

    def update_monitor(self):
        """更新监控数据"""
        if self.monitoring and self.comm.connected:
            # 从队列获取数据
            while not self.comm.data_queue.empty():
                data = self.comm.data_queue.get()

                # 更新显示
                if data['pv'] is not None:
                    self.pv_label.configure(text=f"{data['pv']:.1f}")
                if data['sv'] is not None:
                    self.sv_label.configure(text=f"{data['sv']:.0f}")
                    self.temp_var.set(str(data['sv']))

                # 记录到状态
                if data['pv'] is not None and data['sv'] is not None:
                    diff = data['pv'] - data['sv']
                    self.log(f"{data['timestamp']} PV:{data['pv']:.1f}°C SV:{data['sv']:.0f}°C Δ:{diff:+.1f}°C")

            # 继续更新
            self.master.after(100, self.update_monitor)

    def log(self, message):
        """记录日志"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_message = f"[{timestamp}] {message}"

        # 添加到状态文本框
        self.status_text.insert(tk.END, log_message + "\n")
        self.status_text.see(tk.END)

        # 控制台也输出
        print(log_message)

    def clear_log(self):
        """清空日志"""
        self.status_text.delete(1.0, tk.END)

    def save_config(self):
        """保存配置"""
        config = {
            'port': self.port_var.get(),
            'baudrate': self.baud_var.get(),
            'address': self.addr_var.get(),
            'interval': self.interval_var.get()
        }

        try:
            with open('tc4s_config.json', 'w') as f:
                json.dump(config, f, indent=2)
            self.log("配置已保存")
        except Exception as e:
            self.log(f"保存配置失败: {e}")

    def load_config(self):
        """加载配置"""
        try:
            if os.path.exists('tc4s_config.json'):
                with open('tc4s_config.json', 'r') as f:
                    config = json.load(f)

                self.port_var.set(config.get('port', '/dev/ttyUSB0'))
                self.baud_var.set(config.get('baudrate', '9600'))
                self.addr_var.set(config.get('address', '1'))
                self.interval_var.set(config.get('interval', '1.0'))
        except:
            pass

    def on_closing(self):
        """关闭窗口"""
        if self.monitoring:
            self.toggle_monitor()

        if self.comm.connected:
            self.comm.disconnect()

        # 保存配置
        self.save_config()

        self.master.quit()
        self.master.destroy()


def main():
    """主程序"""
    # 创建主窗口
    root = tk.Tk()

    # 创建GUI
    app = TC4S_GUI(root)

    # 设置关闭事件
    root.protocol("WM_DELETE_WINDOW", app.on_closing)

    # 启动主循环
    root.mainloop()


if __name__ == "__main__":
    main()