# dsh-ui-balance

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的第三方插件：在**每条 AI 回复下方**显示 DeepSeek 账户余额，并在侧边栏显示当前会话花费估算。

不用切到网页查账户，聊天的过程中余额和花费一目了然。

## 前置要求

- dsh `>= 0.1.1-rc.2`（peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-credentials ^0.1.0-rc.7`、`@deepseek-ai/dsh-host-webserver ^0.1.1-rc.2`、`@deepseek-ai/dsh-typert-protocol ^0.1.0-rc.7`、`@deepseek-ai/schemastery ^3.18.1`）
- 已配置 `DEEPSEEK_API_KEY` 凭据（未配置时面板会显示「未配置 DEEPSEEK_API_KEY」而不是静默失败）
- `pnpm` 可用（`dsh plugin` 底层转发给 pnpm）

## 安装

一条命令装完：

```sh
dsh plugin --profile <name> add github:EasyTZ/dsh-ui-balance#v0.5.1
```

`<name>` 换成你的 profile 名（桌面版通常为 `web`，TUI 为 `tui`）。插件自带 `dsh.bundle` 层（`cordis.patch.yml`），`dsh plugin add` 会同时完成「装进去」和「注册激活」，**不需要再手写 patch**。

> 命令里的 `#v0.5.0` 是版本 tag，钉 tag 才能复现；想追最新可以改成 `#main`，但不建议。

重启 dsh 后，每条 AI 回复下方即出现余额行，侧边栏显示本次会话的花费估算。

## 使用

插件随会话自动展示，不需要手动操作：每条 AI 回复下方显示 DeepSeek 账户余额；侧边栏显示当前会话花费（流式估算、按所选模型计价、单价带币种）。未配置 `DEEPSEEK_API_KEY` 时会显示「未配置 DEEPSEEK_API_KEY」而不是静默失败。

## 卸载

一条命令卸载：

```sh
dsh plugin --profile <name> remove @easytz/dsh-ui-balance
```

`<name>` 与安装时一致。`remove` 会把包从 profile 依赖里移除，`dsh` 随后会把它从激活清单（`dsh.profile.bundles`）里撤掉。

> 如果你按旧版 README 手动往 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 或 `$DSH_HOME/cordis.patch.yml` 里加过 `- insert:` 条目，卸载时把那段 YAML 一起删掉。

重启 dsh 后，余额行与侧边栏花费消失。

## 已知限制

- 余额来自 `api.deepseek.com/user/balance`，网络不通或 API Key 无效时会显示错误状态。
- 只展示 DeepSeek 官方 API 的余额，不支持第三方中转。

## 平台支持

插件本身没有平台分支（纯 web UI + HTTP 路由），目前只在 Windows 上随桌面发行版验证过，理论上全平台可用。
