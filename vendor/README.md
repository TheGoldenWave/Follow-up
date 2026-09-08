# Vendor

本目录存放 Follow-up 本地采集层复刻上游 Adapter 的**受控 Vendor 快照**。

- `manifest.json` 是唯一权威 provenance 清单：记录上游仓库、版本或 commit、
  许可证、导入文件、哈希、本地补丁与同步历史。其结构由
  `src/follow_up_acquisition/vendor.py` 校验。
- `last30days/`、`licenses/` 等子目录在首次 `scripts/vendor/sync-last30days.sh`
  成功运行后生成；导入前保持为空或仅含锁定清单。
- 同步策略：下载到临时目录 → 校验 commit 与文件哈希 → 产出可审查 diff，**绝不**
  自动合并上游变更。安全修复与平台协议变化经审查后再同步。
- 引入代码必须保留上游版权与许可证声明（`licenses/` 下的许可证文本随同步写入）。

在同步完成前，本目录不含任何上游代码，`manifest.json` 的 `sha256` / `synced_at` /
`imported_paths` 均为空。
