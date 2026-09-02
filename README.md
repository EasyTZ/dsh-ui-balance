# dsh-ui-balance

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）用的余额与费用详情插件。

在聊天过程中，不用切到网页查账单，侧边栏和弹窗里就能看到：

- DeepSeek 账户余额
- 本次打开 / 本日 / 月度费用
- 每个模型的用量和缓存命中率
- 所有已配置模型的实时单价
- 当前是「峰价」还是「谷价」

## 功能一览

### 侧边栏
- 显示余额和本次打开花费
- 最右侧显示绿色「谷」或蓝色「峰」，一眼看清当前计费时段

### 费用详情弹窗
点开侧边栏余额行，弹出完整面板：

- **API 供应商**：显示当前接入的供应商（DeepSeek / 智谱 GLM / Kimi 等）
- **余额**：DeepSeek / Moonshot(Kimi) 可直接查询；其他厂商显示「无法查询余额」
- **费用汇总表**：本次打开费用、本日费用、月度费用
- **本次打开用量表**：模型、输入未命中、缓存命中、输出、缓存命中率
- **目前单价表**：所有已配置模型的价格，单位统一为每百万 token

### 费用统计
- 本次打开费用：从本次启动开始累计，含进行中消息的实时估算
- 本日费用：当天 00:00 - 23:59:59 累计，自动跨天清零
- 月度费用：当月 1 日 00:00 到最后一天 23:59:59 累计，自动跨月清零
- 多会话并行时，所有正在进行的会话都会计入费用

### 供应商兼容性
| 供应商 | 余额查询 | 费用统计 | 价格表 |
|---|---|---|---|
| DeepSeek | 支持 | 支持 | 支持 |
| Moonshot / Kimi | 支持 | 支持 | 支持 |
| OpenAI / Claude / Grok / Gemini | 显示「无法查询余额」 | 支持 | 支持（需配置模型单价） |

## 前置要求

- dsh `>= 0.1.1-rc.2`
- 已配置 `DEEPSEEK_API_KEY` 凭据
- `pnpm` 可用

## 安装

```sh
dsh plugin --profile <name> add github:EasyTZ/dsh-ui-balance#v0.5.6
```

`<name>` 换成你的 profile 名（桌面版通常为 `web`）。

重启 dsh 后即可使用。

## 卸载

```sh
dsh plugin --profile <name> remove @easytz/dsh-ui-balance
```

## 已知限制

- 余额查询仅 DeepSeek 和 Moonshot/Kimi 有公开接口；其他厂商需要官方提供余额接口后再适配。
- 价格表数据来自本地配置，建议偶尔核对官方定价页。

## 平台支持

纯 web UI + HTTP 路由，理论上全平台可用；目前主要在 Windows 桌面发行版上验证。
