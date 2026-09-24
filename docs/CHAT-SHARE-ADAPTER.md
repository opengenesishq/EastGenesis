# 聊天快照分享适配器

CaoGen 生成静态 HTML，并调用用户在「站点部署」配置的本机程序。分享面板另存一组参数；程序和环境变量来自所选部署目标。CaoGen 不提供托管账号，不把公开链接作为写操作凭据。

分享适配器使用 `caogen-chat-share/1`。每次执行从 stdin 读取一行 JSON，将唯一结果写为一行：

```text
CAOGEN_CHAT_SHARE_RESULT {"protocol":"caogen-chat-share/1", ...}
```

其他诊断可写到 stdout/stderr，但不要输出凭据。最多读取 64 KiB 请求，输出总计 256 KiB；超时最多 120 秒。退出码须为 0，且必须有与请求身份相符的结构化回执。

## 配置

1. 在任务工作区「站点部署」配置可执行文件、环境变量名和超时。程序须使用绝对路径；凭据使用程序已有登录状态或明确允许的环境变量。
2. 在「分享快照 → 用户部署适配器」选择该目标，填写分享参数的 JSON 数组，例如 `["/absolute/path/to/share-adapter.mjs"]`（目标可执行程序为 Node）。
3. 保存配置不会执行程序。准备发布或撤销时，用户确认执行 `describe` 读取账号与能力；查看具体操作预览后再次确认执行发布/撤销。

所有请求由主进程产生。适配器应当重新验证请求中的 `accountScope` 与自己当前登录账号一致，并只读取 `publish.directory/index.html`。不可把目录旁的私有台账上传。

## describe

请求：

```json
{"protocol":"caogen-chat-share/1","requestId":"request-1","operationId":"describe-1","operation":"describe"}
```

响应：

```json
{
  "protocol": "caogen-chat-share/1",
  "requestId": "request-1",
  "operationId": "describe-1",
  "operation": "describe",
  "account": {
    "adapterNamespace": "your-adapter",
    "accountScope": "stable-account-id",
    "targetId": "stable-share-container-id",
    "accountName": "My account",
    "capabilities": {
      "publish": true, "revoke": true, "inspect": true,
      "idempotent": true, "conditionalRevoke": true
    }
  }
}
```

撤销前的 `describe` 还会携带 `adapterNamespace/accountScope/targetId`，响应必须匹配。只读或不能精确撤销单份资源的适配器不开放发布按钮。

## publish

请求在 describe 字段基础上包含：

```json
{
  "operation": "publish",
  "operationId": "chat-share-operation-uuid",
  "adapterNamespace": "your-adapter",
  "accountScope": "stable-account-id",
  "targetId": "stable-share-container-id",
  "shareId": "application-generated-share-uuid",
  "snapshotId": "application-generated-snapshot-uuid",
  "manifestDigest": "64-character-sha256-of-index-html",
  "directory": "/application/private/bundles/snapshot-uuid"
}
```

适配器必须：

- 验证当前账户、目标和 `shareId` 的作用域。
- 校验目录只有 `index.html`，计算文件 SHA-256 与 `manifestDigest` 一致。
- 以 `operationId + shareId + manifestDigest` 幂等处理；相同操作核对已有结果，身份不同则拒绝。
- 发布到该 shareId 独立控制的资源；不能覆写其他站点或其他分享。
- 返回单独版本 `revision` 和无用户名/密码、查询参数或 fragment 的 HTTPS URL。

响应须回显 `protocol/requestId/operationId/operation/shareId/snapshotId/manifestDigest`，并返回上述 `account`。确认发布：

```json
{"result":"applied","publicState":"active","revision":"remote-revision-1","url":"https://your-host.example/shares/share-uuid/"}
```

未发布必须明确确认该资源不存在：`result:not_applied, publicState:absent`。状态无法确认则使用 `result:unknown, publicState:unknown`；CaoGen 不会自动重新发布。

## revoke

请求包含原 `shareId/snapshotId/manifestDigest/accountScope/targetId` 和 `expectedRevision`，**没有 directory 或聊天正文**。

适配器只撤销这一份资源，版本不匹配时不能修改。响应回显原身份及 `expectedRevision`。

- 撤销确认：`result:applied, publicState:revoked`（或 `absent`），以及新 `revision`。
- 未撤销确认：`result:not_applied, publicState:active, revision:原 expectedRevision`。
- 无法确认：`result:unknown, publicState:unknown`。

不可用整站关闭、整桶删除或通配符删除替代单份撤销。撤销不保证移除浏览器缓存或已下载副本。

## inspect

保留**原 operationId** 以及原分享、内容、账号和版本字段，将 `operation` 改为 `inspect`，加入 `originalAction:publish|revoke` 和新的 `requestId`。不传 directory。

只查询原操作的真实状态，不重新发布或撤销。响应回显 `originalAction` 与所有原身份字段，并按照原 action 返回 `applied/not_applied/unknown`。错误 shareId、账号、内容摘要或版本的回执会被拒绝。

CaoGen 在原 Effect 恢复账本与核对回执一致后才更新最终状态。任务关闭/移除不删除分享台账；主工作台可以通过新一次明确的本机授权撤销原分享。

## 公开内容

快照只包含选择后的可见正文和公开标题。系统指令、思考、工具调用/结果、附件字节、原任务身份和本机目录不进入静态文件。正文经过凭据/路径遮盖与 HTML 转义，页面不执行脚本或自动加载外部资源。

用户仍须检查正文中的私人业务信息。适配器不得把未选择的原消息、私有 JSON 台账或任务目录补充上传。
