# SibyX SDK（加密 / 身份层）

> 许可证：MIT — 全文见同目录 `LICENSE`。
> License: MIT — full text in `LICENSE` in this directory.

## 这是什么 / What this is
SDK 是 SibyX 的**加密与身份核心**，属于 MIT 许可的独立组件（与 Web 客户端 Apache-2.0、中继核心 AGPL-3.0 分开授权）。
The SDK is SibyX's **cryptography & identity core** — an independent MIT-licensed component, licensed separately from the Apache-2.0 web client and the AGPL-3.0 relay core.

它负责：
It provides:
- **身份生成**：浏览器本地生成双密钥（ECDSA 签名 + ECDH 加密），无手机号、无密码，密钥即身份。
  Local keypair generation (ECDSA signing + ECDH encryption) — key = identity, no phone, no password.
- **签名 / 验签**：`signMessage` / `verifySignature`（IEEE-P1363，浏览器与 Node 一致）。
- **密钥协商**：ECDH 派生共享密钥 → AES-GCM 端到端加密（私聊）。
  ECDH → AES-GCM for end-to-end private DMs.
- **地址派生**：从公钥派生用户地址。

## 当前状态 / Current status
当前 SDK 代码**内嵌于 `../app.js`**（Web 客户端）中，尚未抽离为独立文件。其 MIT 许可通过以下方式声明：
The SDK code currently lives **embedded inside `../app.js`** (the web client) and has not yet been extracted into its own file. Its MIT license is declared by:
- `../app.js` 文件头：`// SPDX-License-Identifier: Apache-2.0 AND MIT`
- 本目录 `LICENSE`（MIT 全文）

## 计划 / Planned
将把加密 / 身份函数抽离为 `sdk/sibyx-sdk.js`，由 Web 客户端以 `<script>` 引入，使 MIT 边界与 AGPL 中继核心彻底隔离。
Plan: extract the crypto/identity functions into `sdk/sibyx-sdk.js`, loaded by the web client via `<script>`, so the MIT boundary is fully isolated from the AGPL relay core.

> ⚠️ E2EE 红线：签名 / 验签 / 密钥协商 / 加解密与私钥、身份、私有频道密钥**绝不**上服务端。
> E2EE red line: signing, verifying, key agreement, encrypt/decrypt, and private keys / identity / private-channel keys NEVER touch a server.
