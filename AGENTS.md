# 项目上下文

## 技术栈

- **核心**: Vite 7, TypeScript, Express
- **UI**: Tailwind CSS

## 目录结构

```
├── scripts/            # 构建与启动脚本
│   ├── build.sh        # 构建脚本
│   ├── dev.sh          # 开发环境启动脚本
│   ├── prepare.sh      # 预处理脚本
│   └── start.sh        # 生产环境启动脚本
├── server/             # 服务端逻辑
│   ├── routes/         # API 路由
│   ├── server.ts       # Express 服务入口
│   └── vite.ts         # Vite 中间件集成
├── src/                # 前端源码
│   ├── index.css       # 全局样式
│   ├── index.ts        # 客户端入口
│   └── main.ts         # 主逻辑
├── index.html          # 入口 HTML
├── package.json        # 项目依赖管理
├── tsconfig.json       # TypeScript 配置
└── vite.config.ts      # Vite 配置
```

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

## 开发规范

- 使用 Tailwind CSS 进行样式开发

## 关键决策

- **双差分模式支持**：支持两种差分计算模式
  - **拟合后差分**（默认）：先对原始数据进行曲线拟合，再对拟合曲线求导
  - **直接差分**：直接对原始数据进行差分计算，再对差分曲线进行拟合
- 直接差分模式下可选择多种差分算法：SG微分、中心差分、前向差分、后向差分
- 直接差分模式下可独立选择差分曲线的拟合方法：三次样条、多项式、B样条、LOESS

## 数据结构

### Dataset 接口关键字段
- `differential`: 拟合后差分结果
- `directDifferential`: 直接差分结果，包含：
  - `rawDqdv/rawDvdq`: 原始差分数据
  - `fittedDqdv/fittedDvdq`: 差分曲线拟合结果

### AppState 新增字段
- `diffMode`: 'fitted' | 'direct' - 差分模式
- `directDiffParams`: 直接差分参数
- `diffCurveFittingParams`: 差分曲线拟合参数

## 核心计算函数

### calculateDirectDifferential (calculations.ts)
- 直接对原始数据进行差分计算
- 对差分曲线进行独立拟合
- 支持多种差分算法和平滑方法
