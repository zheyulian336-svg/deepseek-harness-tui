# DeepSeek Harness TUI

一个跑在终端里的 DeepSeek Harness 客户端，让程序员在终端中直接和 Harness 的 Agent 交互、开发。

架构上分两块：

- **桥接插件 `dsh-tui-bridge/`**：Harness 的 Host 侧插件，把 agent loop 通过 HTTP（SSE + POST）暴露给终端客户端。
- **TUI 客户端 `client/`**：零依赖的 Node 终端界面，连接桥接插件，建会话、发消息、流式渲染回复、跑工具。

```
终端 ./tui  ──HTTP(SSE+POST)──▶  桥接插件 dsh-tui-bridge  ──▶  agent loop
 (client/index.js)               (Host 组合, /tui/events + /tui/command)
```

## 依赖

- Node.js ≥ 18（客户端零 npm 依赖，只用内置模块）
- 一个运行中的 DeepSeek Harness，且桥接插件已安装（见下）

## 安装桥接插件（在你的 Harness 上）

clone 仓库后，在仓库目录里执行一条命令，把桥接插件装进你的 profile。它会**自动注册为 bundle 层**并应用 `insert` 行，无需手动改组合文件：

```bash
dsh plugin --profile <你的profile名> add "link:./dsh-tui-bridge"
```

例如你的 profile 叫 `desktop`：

```bash
dsh plugin --profile desktop add "link:./dsh-tui-bridge"
```

然后**重启 Harness** 生效。

> 桥接插件暴露两个端点：
> - `GET /tui/events` — SSE 流（server → client）
> - `POST /tui/command` — JSON 命令（client → server）
>
> 命令：`ping` / `list_sessions` / `read_session` / `create_session` / `resume` / `send` / `interrupt` / `subscribe` / `unsubscribe`。

## 快速开始

```bash
# 交互式 TUI（默认连 http://127.0.0.1:43120，新建会话，cwd 取当前目录）
./tui
# 或
node client/index.js

# 指定工作目录 / preset / 已有会话
./tui --cwd /path/to/project --preset standard
./tui --session <session-id>        # 续接一个已有会话

# 非交互模式
./tui --list                        # 列出会话
./tui --once "你的问题"             # 一次性提问，打印回答后退出
./tui --once "..." --dump frame.txt # 并把渲染画面写到 frame.txt
```

### 交互式键位

| 键 | 作用 |
| --- | --- |
| 输入文字 | 编辑输入行 |
| `Enter` | 发送消息 |
| `Backspace` | 删字符 |
| `Ctrl+U` | 清空输入 |
| `Ctrl+L` | 重绘画面 |
| `Ctrl+C` | 退出 |

## 目录

```
deepseek-harness-tui/
├── client/index.js       # TUI 客户端（零依赖 Node）
├── dsh-tui-bridge/       # 桥接插件包（Cordis Host 插件）
│   ├── package.json      #   声明 dsh.bundle，安装时自动注册
│   ├── cordis.patch.yml  #   insert 行
│   └── lib/index.js      #   插件源码（apply）
├── tui                   # 启动器（等价于 node client/index.js）
├── LICENSE
└── README.md
```
