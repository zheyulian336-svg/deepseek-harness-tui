# DeepSeek Harness TUI

一个跑在终端里的 DeepSeek Harness 客户端，让程序员在终端中直接和 Harness 的 Agent 交互、开发。

架构上分两块：

- **桥接插件 `dsh-tui-bridge`**：Harness 的 Host 侧插件，把 agent loop 通过 HTTP（SSE + POST）暴露给终端客户端。**已固化**进 desktop profile 的 Host 组合。
- **TUI 客户端 `client/`**：零依赖的 Node 终端界面，连接桥接插件，建会话、发消息、流式渲染回复、跑工具。

```
终端 ./tui  ──HTTP(SSE+POST)──▶  桥接插件 dsh-tui-bridge  ──▶  agent loop
 (client/index.js)               (Host 组合, /tui/events + /tui/command)
```

## 依赖

- Node.js ≥ 18（客户端零 npm 依赖，只用内置模块）
- 一个运行中的 DeepSeek Harness（desktop profile，桥接插件已固化其中）

## 快速开始

在终端里运行：

```bash
# 交互式 TUI（默认连 http://127.0.0.1:43120，新建会话，cwd 取当前目录）
node client/index.js
# 或
./tui

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

## 桥接插件（已固化）

桥接插件是一个 Host 平面插件，暴露：

- `GET /tui/events` — SSE 流（server → client）
- `POST /tui/command` — JSON 命令（client → server）

命令：`ping` / `list_sessions` / `read_session` / `create_session` / `resume` / `send` / `interrupt` / `subscribe` / `unsubscribe`。

固化方式：插件包 `dsh-tui-bridge/` 通过 `link:` 装进 desktop profile，并在用户补丁层
`~/.dsh/profiles/desktop/cordis.patch.yml` 加了 `insert` 行。**重启 Harness 后生效**（重启前，当前进程里仍是等价的动态插件在跑）。

> 重新固化 / 改桥接源码后：编辑 `dsh-tui-bridge/lib/index.js` 即可（`link:` 指向源码，改动即时生效），然后重启 Harness。

## 目录

```
TUI/
├── client/index.js      # TUI 客户端（零依赖 Node）
├── dsh-tui-bridge/      # 桥接插件包（Cordis Host 插件，已固化进 profile）
│   ├── package.json
│   └── lib/index.js
├── tui                  # 启动器（等价于 node client/index.js）
└── README.md
```
