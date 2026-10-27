# 真实设备连接与调试

适用：桌面 0.8.0 / Web 3.31。支持原项目 TC4S Modbus RTU：PV `0x0000`、SV `0x0002`，默认 9600、8N1、站号 1。接机前核对温控器型号、寄存器与通讯设置。

## Windows

安装 `RoasterDesktop_0.8.0_x64-setup.exe`。软件包含 Python 控制服务、串口依赖、离线工作台和本机 AI 运行时，使用时无需安装 Node/Python。

1. USB-RS485 接电脑，在「设置 → 设备连接」选择真实设备与实际 COM 端口，核对波特率、站号，点击连接。
2. 自动识别只在恰有一个 USB 串口时选中该端口。多个适配器须手动选择；普通蓝牙串口不会自动选中。
3. 底栏显示端口与状态。串口打开后，必须收到合法 PV/SV 响应才显示已连接。没有有效测温时不能开始烘焙。
4. 核实测温值和设备自身状态，再选择曲线并手动开始。软件启动、重连不会写 SV 或自动续烘。

运行中禁止切换设备或模式。本机有未处理的本锅时，关闭桌面窗口会提示先 End，再保存或放弃记录。真实急停仍应独立切断加热；软件连接状态不代表物理断电。

## 树莓派 ARM64

使用 64 位 Raspberry Pi OS、Python 3.11+。`RoasterDevice_0.8.0_linux_arm64.tar.gz` 是部署包，内置 Node ARM64；首次安装 Python 依赖需要网络。没有在 Windows 上交叉编译 Linux 可执行文件。

```sh
sudo apt update
sudo apt install python3-venv python3-dev build-essential curl xdg-utils

# 在解压后的目录运行
sh install-roaster.sh
./open-roaster.sh
```

安装脚本安装依赖、保留已有配置并添加应用菜单入口，不启动烘焙。「咖啡烘焙机控制台」菜单入口会启动本机服务并打开网页。USB-RS485 接派后，在设置中选择对应 `/dev/ttyUSB0` 或 `/dev/ttyACM0`。缺少串口权限时，将运行用户加入 `dialout` 后重新登录，不以 root 日常运行。

## 电脑调试树莓派设备

控制服务默认仅监听本机，避免将现有未鉴权的控机接口开放到局域网。使用树莓派已有 SSH 登录建立隧道，例如在电脑运行：

```sh
ssh -N -L 18000:127.0.0.1:8000 用户名@树莓派地址
```

保持 SSH 窗口运行。电脑浏览器打开 `http://127.0.0.1:18000`；或在 Windows 软件「设备连接 → 控制服务」输入此地址，点击连接地址。此时设置中的串口属于树莓派。「本机」按钮回到电脑直接连接。不要同时运行两个控制服务争用同一串口。

## 源码调试

Windows 双击根目录「调试网页.cmd」或「调试桌面.cmd」，默认使用真实 Python 控制服务。开发环境安装 `roaster/requirements.txt` 与 `desktop/workbench-requirements.txt`，在 `desktop/` 执行 `npm ci`。

树莓派在部署目录运行 `./start-roaster.sh` 查看终端日志；源码可在 `roaster/` 执行 `python3 device_main.py`。服务绑定 `127.0.0.1:8000`。Windows 内置服务使用随机本机端口。

## 模拟器与数据

在「设置 → 设备连接 → 连接模式」选择模拟器并点击连接才启用。模拟器不打开串口；真实／模拟曲线和记录隔离。每次重启控制服务均恢复真实设备模式，串口、波特率、站号保留。

Windows 控制数据在应用数据目录的 `device/`，本机 AI 仍使用 `ai/`；树莓派默认 `~/.local/state/ganf-roaster/`，可用 `ROASTER_STATE_DIR` 修改。运行数据不进入 Git。

本机验证覆盖 Windows 打包运行时、真实控制器与模拟传输。ARM64 安装运行、TC4S 通讯、测温精度、加热和真实急停需在目标设备接机验收。
