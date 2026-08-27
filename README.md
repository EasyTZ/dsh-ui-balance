# dsh-ui-balance

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的第三方插件：在**每条 AI 回复下方**显示 DeepSeek 账户余额。

不用切到网页查账户，聊天的过程中余额一目了然。

## 前置要求

- dsh `>= 0.1.0-rc.7`（peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-credentials ^0.1.0-rc.7`、`@deepseek-ai/dsh-typert-protocol ^0.1.0-rc.7`）
- 已配置 `DEEPSEEK_API_KEY` 凭据（未配置时面板会显示「未配置 DEEPSEEK_API_KEY」而不是静默失败）

## 安装

「装进去」和「打开它」是两件事，缺一不可：

```sh
dsh plugin --profile <name> add dsh-ui-balance
```

## 激活

往 patch 层文件（`$DSH_HOME/profiles/<name>/cordis.patch.yml` 或机器级 `$DSH_HOME/cordis.patch.yml`）里加一条 `- insert:` 条目：

```yaml
- insert:
    - id: balance
      name: 'dsh-ui-balance'
```

重启 dsh 后，每条 AI 回复下方即出现余额行。

## 已知限制

- 余额来自 `api.deepseek.com/user/balance`，网络不通或 API Key 无效时会显示错误状态。
- 只展示 DeepSeek 官方 API 的余额，不支持第三方中转。

## 平台支持

插件本身没有平台分支（纯 web UI + HTTP 路由），目前只在 Windows 上随桌面发行版验证过，理论上全平台可用。
