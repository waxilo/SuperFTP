
<p align="center">
  <h1 align="center">🖥️ SuperFTP</h1>
  <p align="center">
    现代化的跨平台 FTP / SFTP 桌面客户端，基于 <a href="https://v2.tauri.app/">Tauri 2</a> 构建。
  </p>
</p>

---

## ✨ 功能特性

- **双协议支持** — 同时支持 FTP 和 SFTP（SSH），通过纯 Rust 实现，无需外部依赖
- **连接管理** — 保存、编辑、删除多个服务器连接配置，数据持久化到本地
- **远程文件浏览** — 目录列表、面包屑导航、文件详情（大小、权限、修改时间）
- **本地文件浏览** — 侧边栏底部集成本地文件系统面板，快速定位目标目录
- **文件传输** — 支持远程→本地下载、本地→远程上传，通过右键菜单操作
- **文件操作** — 系统默认程序打开、应用内文本查看器、递归删除文件/目录
- **通配符过滤** — 支持 `*` 和 `?` 通配符的文件名快速过滤
- **灵活排序** — 按文件名或修改时间排序，支持升序/降序/默认三种状态
- **明暗主题** — 自动跟随系统亮色/暗色模式偏好
- **跨平台** — 支持 Windows x64、macOS ARM64（Apple Silicon）、macOS x64（Intel）

## 📸 界面概览

```
┌──────────────────────────────────────────────────┐
│  Sidebar                │  Main Panel            │
│                         │                        │
│  ┌─ SuperFTP ──── [+]-┐ │  /home/user/projects  │  🔄
│  │ Connections         │ │  ──────────────────── │
│  │                     │ │                        │
│  │ 🔌 My Server        │ │  📁 src/               │
│  │    ftp://admin@...  │ │  📁 docs/              │
│  │                     │ │  📄 README.md          │
│  │ ⚡ Prod Server (SFTP)│ │  📄 package.json       │
│  │    sftp://root@...  │ │                        │
│  ├─────────────────────┤ │                        │
│  │ Local               │ │                        │
│  │ 📂 ~/Downloads      │ │                        │
│  │  📄 report.csv      │ │                        │
│  │  📁 images/         │ │                        │
│  └─────────────────────┘ │                        │
└──────────────────────────────────────────────────┘
```

## 🏗️ 技术架构

### 后端（Rust / Tauri 2）

| 模块 | 说明 |
|------|------|
| [`ftp.rs`](src-tauri/src/ftp.rs) | FTP 协议实现、会话池管理、数据模型定义 |
| [`sftp.rs`](src-tauri/src/sftp.rs) | 基于 [russh](https://crates.io/crates/russh) 的纯 Rust SFTP 实现 |
| [`transfer.rs`](src-tauri/src/transfer.rs) | 文件传输操作（下载/上传/删除） |
| [`local.rs`](src-tauri/src/local.rs) | 本地文件系统浏览与操作 |
| [`lib.rs`](src-tauri/src/lib.rs) | 14 个 Tauri 命令注册与会话路由 |

**关键依赖：**
- [`suppaftp`](https://crates.io/crates/suppaftp) — 异步 FTP 客户端库
- [`russh`](https://crates.io/crates/russh) + [`russh-sftp`](https://crates.io/crates/russh-sftp) — 纯 Rust SSH/SFTP 实现，使用 `ring` 加密后端，避免 Windows 上 NASM 编译问题
- [`tauri-plugin-store`](https://v2.tauri.app/plugin/store/) — 连接配置持久化

### 前端（React / TypeScript / Vite）

| 模块 | 说明 |
|------|------|
| [`App.tsx`](src/App.tsx) | 主应用组件，全局状态管理 |
| [`components/Sidebar.tsx`](src/components/Sidebar.tsx) | 连接列表侧边栏 |
| [`components/LocalBrowser.tsx`](src/components/LocalBrowser.tsx) | 本地文件系统浏览器 |
| [`components/FileList.tsx`](src/components/FileList.tsx) | 远程文件列表（含排序） |
| [`components/ConnectionForm.tsx`](src/components/ConnectionForm.tsx) | 新建/编辑连接表单 |
| [`components/ContextMenu.tsx`](src/components/ContextMenu.tsx) | 右键上下文菜单 |
| [`components/TextViewer.tsx`](src/components/TextViewer.tsx) | 应用内文本文件查看器 |
| [`components/FilterBar.tsx`](src/components/FilterBar.tsx) | 文件过滤栏 |
| [`components/Toast.tsx`](src/components/Toast.tsx) | 通知提示组件 |

**关键依赖：**
- [`@tauri-apps/api`](https://www.npmjs.com/package/@tauri-apps/api) — Tauri 前端 API
- [`lucide-react`](https://lucide.dev/) — 图标库
- [`@tauri-apps/plugin-opener`](https://v2.tauri.app/plugin/opener/) — 系统默认程序打开文件

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/) >= 1.70
- 系统级依赖：
  - **Windows**: 需安装 [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（包含 Windows SDK）
  - **macOS**: 需安装 Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: 需安装 `libwebkit2gtk-4.1-dev` 等 Tauri 系统依赖

### 克隆与运行

```bash
# 克隆仓库
git clone https://github.com/your-org/SuperFTP.git
cd SuperFTP

# 安装前端依赖
npm install

# 启动开发模式（Vite HMR + Tauri 窗口）
npm run tauri dev

# 构建生产版本
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/` 目录。

### 开发提示

- 前端开发服务器运行在 `http://localhost:1420`
- Vite 配置忽略 `src-tauri` 目录的文件监听，避免触发不必要的重编译
- 按 `Ctrl+F` 可在文件列表中打开通配符过滤栏
- 按 `Esc` 可依次关闭：文本查看器 → 右键菜单 → 过滤栏

## 📦 发布流程

本项目使用 GitHub Actions 自动化构建和发布：

1. **开发** — 在功能分支上开发，向 `main` 分支发起 PR
2. **CI 校验** — PR 触发 CI 工作流，构建 macOS ARM64/x64 和 Windows x64 三个平台
3. **发布** — 推送版本标签（如 `v0.1.7`）触发 Release 工作流，自动构建所有平台并创建 GitHub Release

也可使用快速发布脚本：
- **macOS**: `./fast_push_mac.sh` — 自动构建并推送 tag
- **Windows**: `fast_push_win.ps1` 或 `fast_push_win.bat`

## 📁 项目结构

```
SuperFTP/
├── src/                          # React 前端源码
│   ├── main.tsx                  # 应用入口
│   ├── App.tsx                   # 主组件
│   ├── App.css                   # 全局样式（含明暗主题）
│   ├── types.ts                  # TypeScript 类型定义
│   ├── api/                      # Tauri 命令调用封装
│   │   ├── ftp.ts                # FTP 相关 API
│   │   └── local.ts             # 本地文件系统 API
│   ├── components/               # UI 组件
│   │   ├── Sidebar.tsx           # 连接侧边栏
│   │   ├── LocalBrowser.tsx      # 本地文件浏览器
│   │   ├── FileList.tsx          # 远程文件列表
│   │   ├── Breadcrumb.tsx        # 面包屑导航
│   │   ├── ConnectionForm.tsx    # 连接编辑表单
│   │   ├── ContextMenu.tsx       # 右键菜单
│   │   ├── TextViewer.tsx        # 文本查看器
│   │   ├── FilterBar.tsx         # 过滤栏
│   │   └── Toast.tsx            # 通知提示
│   ├── stores/                   # 状态持久化
│   │   └── connections.ts        # 连接配置文件读写
│   └── utils/
│       └── filter.ts             # 通配符过滤正则引擎
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs               # 应用入口
│   │   ├── lib.rs                # Tauri 命令注册
│   │   ├── ftp.rs                # FTP 协议与数据模型
│   │   ├── sftp.rs               # SFTP 协议实现
│   │   ├── transfer.rs           # 文件传输
│   │   └── local.rs             # 本地文件系统
│   ├── Cargo.toml                # Rust 依赖配置
│   ├── tauri.conf.json           # Tauri 应用配置
│   └── build.rs                  # 构建脚本
├── .github/workflows/
│   ├── ci.yml                    # PR 校验工作流
│   └── release.yml               # 发布工作流
├── package.json                  # Node.js 依赖
├── vite.config.ts                # Vite 构建配置
└── tsconfig.json                 # TypeScript 配置
```

## 🛠️ 内置命令一览

| 命令名 | 功能 |
|--------|------|
| `ftp_connect` | 连接 FTP/SFTP 服务器 |
| `ftp_disconnect` | 断开服务器连接 |
| `ftp_list` | 列出远程目录内容 |
| `ftp_cd` | 切换远程工作目录 |
| `ftp_download` | 下载文件到本地目录 |
| `ftp_upload` | 上传本地文件到远程 |
| `ftp_delete` | 删除远程文件/目录（递归） |
| `ftp_open_temp` | 下载到临时目录并通过系统默认程序打开 |
| `ftp_read_text` | 读取远程文本文件内容（应用内预览） |
| `local_home` | 获取本地用户主目录 |
| `local_list` | 列出本地目录内容 |
| `local_read_text` | 读取本地文本文件内容 |
| `local_delete` | 删除本地文件/目录（递归） |

## 📄 许可证

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with 🦀 Rust + ⚛️ React + 💚 Tauri</sub>
</p>
