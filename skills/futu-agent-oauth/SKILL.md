---
name: futu-agent-oauth
description: 当 agent 需要访问企业内部系统、调用内部 API时必须先调用此 skill 完成 OAuth 认证，获取 access token 。如果API请求返回 Futu_Agent_AccessToken 缺失或不合法错误，也需调用此 skill 后重试。除非用户特别说明，默认自动执行 get-token 子命令获取 token，无需询问。
---

# futu-agent-oauth

企业内部 OAuth Token 管理工具，基于 Authorization Code Flow + PKCE。

## 默认操作

直接运行脚本获取 token：

```bash
# 默认权限范围
sh scripts/get-token.sh

# 支持传递参数
sh scripts/get-token.sh --env PROD --scope "fls,fmonitor,fapm"
```

## OAuth权限范围 (Scope) 功能

**新功能**：支持通过 `--scope` 参数指定OAuth权限范围，不同权限范围的token独立存储和管理。

### 支持的输入格式

```bash
# 空格分隔格式（OAuth 2.0 标准）
--scope "openid profile email"

# 逗号分隔格式（用户友好）
--scope "openid,profile,email"

# 混合格式（自动规范化）
--scope "openid, profile email, api:read"
```

### 使用示例

```bash
# 获取测试环境的默认权限token
node scripts/futu-agent-oauth.js get-token --env TEST

# 获取生产环境特定权限范围的token
node scripts/futu-agent-oauth.js get-token --env PROD --scope "openid profile email"

# 获取管理员权限token (支持逗号分隔输入)
node scripts/futu-agent-oauth.js get-token --env PROD --scope "openid,profile,admin"

# 获取API读取权限token
node scripts/futu-agent-oauth.js get-token --env TEST --scope "openid profile api:read"

# Shell脚本同样支持参数传递
sh scripts/get-token.sh --env PROD --scope "openid,profile,email"
```

获取有效的 access token 并保存到文件。若 token 已过期自动刷新，若无缓存则：
- **有浏览器环境**：自动打开浏览器完成授权
- **无头环境且设置了 `AI_AGENT_KEY` 和 `OA_USER`**：通过飞书推送授权链接，用户点击完成授权
- **无头环境且未同时设置 `AI_AGENT_KEY` 和 `OA_USER`**：打印授权链接到 stderr，提示用户在本地浏览器打开

## 其他命令

### 重新授权

```bash
node scripts/futu-agent-oauth.js login --env PROD --scope "openid profile"
```

清除指定环境和OAuth权限范围的旧 token，强制走一次完整的浏览器授权流程。

### 登出

```bash
node scripts/futu-agent-oauth.js logout --env TEST --scope "openid profile email"
```

清除指定环境和OAuth权限范围的本地缓存的 token 和 client 注册信息。

### 查看状态

```bash
node scripts/futu-agent-oauth.js status --env TEST --scope "openid profile"
```

显示指定环境和OAuth权限范围的 client_id、token 有效期、scope、refresh token 是否存在。


## 无头环境（AgentServer）说明

在无浏览器的环境中，脚本自动检测并切换到无头授权流程。检测逻辑：
- 设置了 `AGENT_SERVER` 环境变量：强制使用无头模式
- Linux 系统且无显示服务器（无 `DISPLAY` 和 `WAYLAND_DISPLAY`）：自动切换到无头模式
- macOS 和 Windows：默认使用浏览器模式

**方式一：飞书推送（推荐，需同时设置 AI_AGENT_KEY 和 OA_USER）**

```bash
export AGENT_SERVER=1            # 明确标识 AgentServer 环境（可选）
export AI_AGENT_KEY=   # AI中台 个人或者应用密钥
export OA_USER=zhangsan          # OA 账号
sh scripts/get-token.sh --env PROD --scope "openid"
# → 用户收到飞书消息，点击授权链接即可
```

**方式二：手动 URL（无需同时设置 AI_AGENT_KEY 和 OA_USER）**

```bash
sh scripts/get-token.sh --env PROD --scope "openid"
# → stderr 打印授权链接，用户在本地浏览器打开完成授权
# → 授权链接会出现在 Claude 的工具结果中，Claude 可提取后展示给用户
```

授权完成后 token 写入缓存，后续调用直接返回缓存，无需重复授权。

## 使用说明

1. 默认执行 `sh scripts/get-token.sh`，无需询问用户
2. **Token输出**：`get-token` 命令将token输出到stdout，适合Shell脚本集成；进度信息输出到stderr
3. 若命令返回非 0，将错误信息展示给用户，建议运行 login 子命令重新授权
4. 首次运行会自动完成动态客户端注册（RFC 7591），无需手动配置 client_id
5. 无头环境下轮询等待最长 10 分钟，超时后报错，需重新运行
6. **安全存储**：token缓存使用AES-256-GCM加密，基于机器指纹派生密钥

## Token 存储

**多环境多OAuth权限隔离**：token按环境(env)和OAuth权限范围(scope)进行隔离存储

**安全加密存储**：所有敏感的token数据（access token、refresh token、client registration）都使用AES-256-GCM加密存储，基于机器指纹派生加密密钥

**存储路径结构**：
```
~/.cache/futu-agent-oauth/
├── prod/
│   ├── openid-profile/           # 生产环境默认权限范围
│   │   └── cache.json
│   ├── openid-profile-email/     # 生产环境包含邮箱权限
│   │   └── cache.json
│   └── openid-profile-admin/     # 生产环境管理员权限
│       └── cache.json
└── test/
    └── openid-profile/           # 测试环境默认权限范围
        └── cache.json
```

**主缓存文件**：`cache.json`
- 包含完整的token信息（access_token、refresh_token、过期时间、scope等）
- 用于内部token管理和刷新逻辑
- **加密存储**：使用AES-256-GCM加密，基于机器指纹派生密钥

**Token 访问方式**：
- **Shell脚本**：直接调用 `sh scripts/get-token.sh` 获取token（输出到stdout）
- **Node.js程序**：使用 `getToken()` API 获取 access_token
- **自动续期**：如果缓存的token已过期，会自动尝试刷新获取新token
- **加密存储**：所有token数据都加密存储在 cache.json 中

### OAuth权限范围 (Scope) 说明

**支持的输入格式**：
- 空格分隔：`"openid profile email"` (OAuth 2.0 标准格式)
- 逗号分隔：`"openid,profile,email"` (用户友好格式)
- 混合格式：`"openid, profile email, api:read"` (自动规范化)


### 其他 skill 接入方式

**方式一：直接调用Shell脚本（最简单）**：
```bash
# 直接调用get-token.sh获取token（进度信息会输出到stderr）
ACCESS_TOKEN=$(sh scripts/get-token.sh)

# 指定环境和权限范围
ACCESS_TOKEN=$(sh scripts/get-token.sh --env PROD --scope "openid,profile,email")

# 使用获取的token调用API
curl -H "Authorization: Bearer $ACCESS_TOKEN" https://api.example.com/data
```

**方式二：Node.js API接入（推荐）**：
```javascript
import { getToken, setTokenContext } from '@futu/futu-agent-oauth';

// 设置环境和权限范围
setTokenContext({ env: 'prod', scope: 'openid profile email' });

// 获取token（自动续期）
const token = await getToken();
if (token) {
  // 使用token调用API
  const response = await fetch('https://api.example.com/data', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
}
```

## 环境变量配置

### 基础配置

**常用环境变量** (可选，可被CLI参数覆盖)：

```bash
# 默认环境配置
export FUTU_OAUTH_ENV=PROD                              # 默认环境 (PROD/TEST)
export FUTU_OAUTH_SCOPE="openid profile"                # 默认OAuth权限范围
export HOST_NETWORK_ENVIRONMENT=TEST                    # 兼容性环境变量

# 自定义服务器
export FUTU_OAUTH_SERVER=https://custom-server.com     # 自定义OAuth服务器
```

### 环境切换

**支持的环境**：
- **PROD** (生产环境，默认): `https://api-mcp.futuoa.com`
- **TEST** (测试环境): `https://test-api-mcp.futuoa.com`

**推荐方式：使用CLI参数**（无需设置环境变量）
```bash
# 生产环境（默认）
sh scripts/get-token.sh --scope "openid profile"

# 测试环境
sh scripts/get-token.sh --env TEST --scope "openid profile"
```

**传统方式：环境变量**（仍然支持）
```bash
# 测试环境
export HOST_NETWORK_ENVIRONMENT=TEST
sh scripts/get-token.sh --scope "openid profile"

# 生产环境（默认）
unset HOST_NETWORK_ENVIRONMENT
sh scripts/get-token.sh --scope "openid profile"
```

**⚠️ 重要：不同环境的token自动隔离**

每个环境的token自动存储在不同路径下，无需手动清理缓存：
```bash
~/.cache/futu-agent-oauth/
├── prod/openid-profile/cache.json    # 生产环境token
└── test/openid-profile/cache.json    # 测试环境token
```

**配置优先级**：
1. CLI参数 `--env` (推荐，最高优先级)
2. 环境变量 `FUTU_OAUTH_ENV`
3. 环境变量 `HOST_NETWORK_ENVIRONMENT` (兼容性)
4. 环境变量 `FUTU_OAUTH_SERVER` (自定义服务器)
5. 默认值 `PROD`

### 高级配置

**超时配置** (可选，单位: 毫秒)：
```bash
export FUTU_OAUTH_AUTH_TIMEOUT_MS=300000          # 浏览器授权超时，默认 5 分钟
export FUTU_OAUTH_HEADLESS_TIMEOUT_MS=600000      # 无头授权超时，默认 10 分钟
export FUTU_OAUTH_HTTP_TIMEOUT_MS=10000           # HTTP 请求超时，默认 10 秒
```

**其他配置** (可选)：
```bash
export FUTU_OAUTH_CACHE_DIR="~/.cache/oauth"      # 自定义缓存目录
export FUTU_OAUTH_LOCK_RETRIES=20                 # 文件锁重试次数，默认 20
```

## 快速开始

**最常用的使用方式**：

```bash
# 1. 生产环境默认权限（openid profile）
sh scripts/get-token.sh

# 2. 测试环境
sh scripts/get-token.sh --env TEST

# 3. 自定义权限范围
sh scripts/get-token.sh --scope "openid,profile,email"

# 4. 查看当前状态
node scripts/futu-agent-oauth.js status

# 5. 重新授权（遇到问题时）
node scripts/futu-agent-oauth.js login
```

**常见问题处理**：
- **Token过期/无效**：会自动刷新，无需处理
- **权限不足**：使用 `--scope` 参数指定更多权限
- **认证错误**：运行 `login` 命令重新授权
- **环境切换**：直接使用 `--env` 参数，无需清理缓存