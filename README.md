# WeCom (WeChat Work) Channel Plugin for Clawdbot

Maintainer: YanHaidao (VX: YanHaidao)

Status: WeCom intelligent bot (API mode) via encrypted webhooks + passive replies (stream).

## Install

### Option A: Install from npm
```bash
clawdbot plugins install @clawdbot/wecom
clawdbot plugins enable wecom
clawdbot gateway restart
```

### Option B: Local development (link)
```bash
clawdbot plugins install --link extensions/wecom
clawdbot plugins enable wecom
clawdbot gateway restart
```

## Configure

```json5
{
  channels: {
    wecom: {
      enabled: true,
      webhookPath: "/wecom",
      token: "YOUR_TOKEN",
      encodingAESKey: "YOUR_ENCODING_AES_KEY",
      receiveId: "",
      dm: { policy: "pairing" }
    }
  }
}
```

## Notes

- Webhooks require public HTTPS. For security, only expose the `/wecom` path to the internet.
- Stream behavior: the first reply may be a minimal placeholder; WeCom will call back with `msgtype=stream` to refresh and fetch the full content.
- Limitations: passive replies only; standalone send is not supported.

---

# Clawdbot 企业微信（WeCom）Channel 插件

维护者：YanHaidao（VX：YanHaidao）

状态：支持企业微信智能机器人（API 模式）加密回调 + 被动回复（stream）。

## 安装

### 方式 A：从 npm 安装
```bash
clawdbot plugins install @clawdbot/wecom
clawdbot plugins enable wecom
clawdbot gateway restart
```

### 方式 B：本地开发（link）
```bash
clawdbot plugins install --link extensions/wecom
clawdbot plugins enable wecom
clawdbot gateway restart
```

## 配置

本节将详细说明如何在企业微信管理后台创建机器人，并配置 Clawdbot 与其对接。

### 前置条件

- 拥有**管理员权限**的企业微信企业（若无企业，可参考[官方文档](https://work.weixin.qq.com/)创建）
- 一台具有**公网 IP** 的服务器（如腾讯云 Lighthouse、阿里云 ECS 等）
- 服务器需支持 **HTTPS**（企业微信要求回调地址必须是 HTTPS）

> ⚠️ **注意**：如果服务器位于中国内地地域，创建机器人时会提示需完成 ICP 备案才可使用。

### 第一步：创建企业微信机器人

1. 登录[企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入「安全与管理」→「管理工具」
3. 滑动到页面底部，点击「创建机器人」
4. 选择「**API 模式创建**」

### 第二步：填写机器人配置

在创建页面填写以下信息：

| 配置项 | 说明 |
|--------|------|
| **名称** | 机器人的显示名称，如「Clawdbot 助手」 |
| **简介** | 机器人的功能描述 |
| **可见范围** | 选择哪些部门/成员可以使用该机器人 |
| **URL** | 回调地址，格式为 `https://你的服务器地址:端口/wecom`<br>例如：`https://example.com:18789/wecom` |
| **Token** | 点击「随机获取」自动生成，**请妥善保存** |
| **EncodingAESKey** | 点击「随机获取」自动生成，**请妥善保存** |

> 💡 **提示**：Token 和 EncodingAESKey 是企业微信与 Clawdbot 进行加密通信的密钥，请务必保存好这两个值。

### 第三步：配置 Clawdbot

编辑 Clawdbot 配置文件（通常位于 `~/.clawdbot/clawdbot.json`），在 `channels` 下添加 `wecom` 配置：

```json5
{
  // ... 其他配置 ...
  channels: {
    wecom: {
      enabled: true,
      webhookPath: "/wecom",
      token: "填入上一步生成的 Token",
      encodingAESKey: "填入上一步生成的 EncodingAESKey",
      receiveId: "",
      dm: { policy: "pairing" }
    }
  }
}
```

> ⚠️ **注意**：JSON 格式要求严格，不要遗漏逗号。

同时确保 `gateway` 配置中的 `bind` 设置正确：

```json5
{
  gateway: {
    bind: "lan"  // 或 "0.0.0.0" 以监听所有网络接口
  }
}
```

### 第四步：启动 Gateway

```bash
clawdbot gateway --port 18789 --verbose
```

### 第五步：验证回调地址

回到企业微信管理后台，点击「保存」按钮。企业微信会向你的服务器发送验证请求：

- 如果验证成功，机器人创建完成
- 如果验证失败，请检查：
  - 服务器是否可以公网访问
  - 端口是否开放
  - HTTPS 证书是否有效
  - Token 和 EncodingAESKey 是否配置正确

### 第六步：开始使用

创建成功后，扫描二维码添加机器人为好友，即可开始对话！

---

## 完整配置参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `enabled` | boolean | 否 | 是否启用该频道，默认 `true` |
| `webhookPath` | string | 是 | Webhook 路径，需与企业微信后台配置的 URL 路径一致 |
| `token` | string | 是 | 企业微信后台生成的 Token |
| `encodingAESKey` | string | 是 | 企业微信后台生成的 EncodingAESKey |
| `receiveId` | string | 否 | 接收消息的企业 ID，通常留空 |
| `welcomeText` | string | 否 | 用户首次进入聊天时的欢迎语 |
| `dm` | object | 否 | 私聊策略配置 |
| `dm.policy` | string | 否 | 私聊策略：`pairing`（配对）、`allowlist`（允许列表）、`open`（开放）、`disabled`（禁用） |
| `dm.allowFrom` | array | 否 | 当策略为 `allowlist` 时，允许的用户 ID 列表 |

### 多账户配置

如需配置多个企业微信账户，可使用 `accounts` 字段：

```json5
{
  channels: {
    wecom: {
      enabled: true,
      defaultAccount: "main",
      accounts: {
        main: {
          webhookPath: "/wecom/main",
          token: "TOKEN_1",
          encodingAESKey: "KEY_1",
          receiveId: ""
        },
        backup: {
          webhookPath: "/wecom/backup",
          token: "TOKEN_2",
          encodingAESKey: "KEY_2",
          receiveId: ""
        }
      }
    }
  }
}
```

---

## 常见问题

### Q: 验证回调地址失败怎么办？

A: 请按以下步骤排查：
1. 确认服务器公网 IP 可访问
2. 确认防火墙/安全组已开放对应端口
3. 确认 HTTPS 证书有效（可使用 Let's Encrypt 免费证书）
4. 确认 `webhookPath` 与企业微信后台配置的 URL 路径一致
5. 查看 Clawdbot 日志，确认请求是否到达

### Q: 机器人收到消息但没有回复？

A: 可能原因：
1. AI 模型配置不正确，请检查 Clawdbot 的模型配置
2. 查看日志确认是否有错误信息
3. 确认 `dm.policy` 不是 `disabled`

### Q: 回复内容显示「收到请稍后~」？

A: 这是正常的 Stream 模式行为。企业微信会自动刷新获取完整回复。如果一直停留在这个状态，请检查 AI 处理是否出错。

### Q: 中国内地服务器提示需要备案？

A: 企业微信要求中国内地服务器必须完成 ICP 备案。你可以：
1. 完成 ICP 备案后继续使用
2. 使用中国香港或海外服务器（无需备案）

---

## 说明

- Webhook 必须是公网 HTTPS。出于安全考虑，建议只对外暴露 `/wecom` 路径
- Stream 模式：第一次回包可能是占位符「收到请稍后~」；随后企业微信会以 `msgtype=stream` 回调刷新拉取完整内容
- 限制：仅支持被动回复，不支持脱离回调的主动发送
