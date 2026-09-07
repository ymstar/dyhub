# douyin-sign（第三方签名资产）

轻量采集内核（`DYHUB_COLLECTOR=lightweight`）运行时依赖的抖音签名脚本：



| 文件           | 用途                                        | 来源                                                                                |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `a_bogus.js` | 生成 HTTP 接口签名 `a_bogus`                    | [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher) |
| `sign.js`    | 生成 WebSocket 连接签名（X-Bogus，webmssdk 反混淆产物） | 同上                                                                                |

## 许可证声明

这两个文件来源于 [DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher)（**AGPL-3.0**），

作为独立的第三方组件随 dyhub 分发，**不修改、不并入 dyhub 的 MIT 代码**，

仅供 dyhub 运行时通过 `vm` 加载执行。若你计划对这两个文件本身做修改或再分发，

需遵循 AGPL-3.0 条款（完整许可证见上游仓库）。



* 上游许可证：[https://github.com/saermart/DouyinLiveWebFetcher/blob/main/LICENSE](https://github.com/saermart/DouyinLiveWebFetcher/blob/main/LICENSE)

* 技术风险提示：抖音 webmssdk 签名算法可能随平台更新失效，失效时请更新这两个文件或回退 `DYHUB_COLLECTOR=browser`。