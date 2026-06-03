## vX.Y (YYYY-MM-DD)

### 上一版本功能摘要（vX.Y-1）
- [复制上一版本的核心改进作为摘要]

### 核心改进

1. **[功能/改动标题]**
   - `文件路径`: [具体改动内容]
   - 原因：[为什么做这个改动]

2. **[另一项功能/改动]**
   - `文件路径`: [具体改动]
   - 原因：[为什么]

### 代码注释
- `文件路径`: [添加或更新了哪些注释]

### 项目结构（vX.Y）

```
roaster/
├── main.py                      # FastAPI 应用入口
├── config.yaml                  # 配置文件
├── requirements.txt             # Python 依赖
├── CHANGELOG.md                 # 历史版本更新记录
├── UPDATE_LOG.md                # 版本更新记录（本文件）
├── README.md                    # 项目说明文档
├── .gitignore                   # Git 忽略规则
├── src/
│   ├── hardware/
│   │   └── tc4s_async.py        # 异步 TC4S Modbus RTU 通讯模块
│   ├── core/
│   │   ├── events.py            # 状态机枚举
│   │   ├── models.py            # Pydantic 数据模型
│   │   └── roaster_controller.py # 核心控制器
│   ├── services/
│   │   └── data_manager.py      # 曲线库与烘焙记录持久化
│   └── web/
│       └── web_api.py           # FastAPI REST API + WebSocket
├── data/
│   ├── profiles/                # JSON 格式烘焙曲线
│   └── records/                 # SQLite 数据库与导出文件
└── static/
    ├── index.html               # 主控页面
    ├── editor.html              # 曲线编辑器页面
    ├── css/
    │   ├── style.css            # 主页面样式
    │   └── editor.css           # 编辑器样式
    └── js/
        ├── utils.js             # 公共工具函数
        ├── app.js               # 主页面逻辑
        └── editor.js            # 编辑器逻辑
```
