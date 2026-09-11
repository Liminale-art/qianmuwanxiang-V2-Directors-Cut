// Existing module packages only; this is not an all-device snapshot or sync protocol.
export function renderStorageBackupSection() {
  return `<details class="sd-storage-disclosure sd-storage-backup-section" data-storage-section="backups">
    <summary>备份与恢复</summary>
    <div class="sd-storage-disclosure-body">
      <div class="sd-storage-backup-row"><span>专注语音原件</span><button type="button" class="sd-btn sd-storage-focus-library">选择备份／恢复／清理</button></div>
      <p class="sd-storage-scope">按内容分别备份。配置不包含素材原件；导入配置会覆盖现有设置。分镜资源包的范围在导出前核对，不代表全部聊天备份。</p>
      <div class="sd-storage-backup-row"><span>配置</span><button type="button" class="sd-btn sd-export-config">导出</button><button type="button" class="sd-btn sd-import-config">导入</button><input type="file" class="sd-import-config-file" accept="application/json,.json" hidden></div>
      ${[['storyboard','分镜资源','.qmb,application/json,.json'],['reader','伴读资料','application/json,.json'],['favorites','语音收藏','application/json,.json'],['notes','固定便笺','application/json,.json']].map(([key,label,accept])=>`<div class="sd-storage-backup-row"><span>${label}</span><button type="button" class="sd-btn" data-storage-export="${key}" aria-label="导出${label}">导出</button><button type="button" class="sd-btn" data-storage-pick="${key}" aria-label="导入${label}">导入</button><input type="file" data-storage-import="${key}" accept="${accept}" hidden></div>`).join('')}
    </div>
  </details>`;
}
