/**
 * 把 provenance.json 的当前进度同步到 LICENSE / PROVENANCE / README / CONTRIBUTING。
 * 只改数量与进度句，不改正文。
 */
import FS from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await FS.readFile(path.join(ROOT, 'provenance.json'), 'utf8'));
const count = (list, b) => list.filter((p) => p.b === b).length;
const upstreamLinux = count(manifest.original_pages, 'linux');
const upstreamK8s = count(manifest.original_pages, 'k8s');
const upstreamTotal = manifest.original_pages.length;
const rewritten = manifest.rewritten_pages.length;
const date = manifest.last_updated || new Date().toISOString().slice(0, 10);

async function edit(file, replacers) {
  const p = path.join(ROOT, file);
  let text = await FS.readFile(p, 'utf8');
  for (const [re, next] of replacers) {
    if (!re.test(text)) throw new Error(`${file}: 找不到要更新的进度句 ${re}`);
    text = text.replace(re, next);
  }
  await FS.writeFile(p, text);
  console.log('updated', file);
}

await edit('LICENSE', [
  [
    /command\/linux\/ 下源自上游、尚未重写的 \d+ 个页面/,
    `command/linux/ 下源自上游、尚未重写的 ${upstreamLinux} 个页面`,
  ],
]);

await edit('PROVENANCE.md', [
  [
    /当前进度：仍属上游 \d+ 页（Linux \d+ \+ K8s \d+），已重写 \d+ 页/,
    `当前进度：仍属上游 ${upstreamTotal} 页（Linux ${upstreamLinux} + K8s ${upstreamK8s}），已重写 ${rewritten} 页`,
  ],
]);

await edit('README.md', [
  [
    /截至 \d{4}-\d{2}-\d{2} 已重写 \d+ 页,剩余 \d+ 个 Linux 页面和 \d+ 个 K8s 页面仍属上游/,
    `截至 ${date} 已重写 ${rewritten} 页,剩余 ${upstreamLinux} 个 Linux 页面和 ${upstreamK8s} 个 K8s 页面仍属上游`,
  ],
]);

await edit('CONTRIBUTING.md', [
  [
    /截至 \d{4}-\d{2}-\d{2} 已重写 \d+ 页,剩余 Linux \d+ 页 \+ K8s \d+ 页/,
    `截至 ${date} 已重写 ${rewritten} 页,剩余 Linux ${upstreamLinux} 页 + K8s ${upstreamK8s} 页`,
  ],
]);

console.log(
  `provenance: 上游 ${upstreamTotal} 页 (Linux ${upstreamLinux}, K8s ${upstreamK8s}), 已重写 ${rewritten} 页`
);
