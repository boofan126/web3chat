# SibyX SDK — 加密 / 身份 / 密钥层

SDK 封装了 SibyX 的所有前端密码学逻辑，作为独立模块供 `app.js` 调用。

**许可**：MIT（详见同目录 `LICENSE`）

## 功能

- **密钥派生**：BIP39 12 词助记词 → P-256 确定性密钥对（ECDSA 签名 + ECDH 加密）
- **签名验签**：ECDSA P-256 SHA-256（`signMessage` / `verifyMessage`）
- **端到端加密**：ECDH 派生 AES-GCM 256 位密钥（`deriveAES` / `encryptText` / `decryptText`）
- **地址派生**：公钥 → SHA-256 截 20 字节 → `0x` 地址
- **频道密钥**：AES-GCM 256 位对称密钥生成/导入/导出
- **备份加密**：PBKDF2-SHA256（25 万次迭代）+ AES-GCM 加密/解密
- **工具函数**：base64/base64url 编解码、椭圆曲线运算、`dmRoomId`

## 使用

SDK 在 `window.SibyXCrypto` 命名空间下引用，同时所有函数作为全局可用（`wordlist.js` → `sdk/sibyx-sdk.js` → `app.js` 加载顺序）。

```js
// 示例：验签
const ok = await verifyMessage(pubKeyB64, 'hello', sigB64);

// 示例：派生身份
const { rec, mnemonic } = await generateMnemonicIdentity();

// 示例：加密消息
const aesKey = await deriveAES(myDhPriv, peerDhPubB64);
const { iv, cipher } = await encryptText(aesKey, 'Hello, world!');
```

## 边界

SDK 不依赖 IndexedDB、不管理应用状态、不操作 DOM。所有需要持久化（身份存储、消息归档）的逻辑留在 `app.js` 中。
