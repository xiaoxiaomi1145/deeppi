import { readPrivateJson, writePrivateJson as write } from '../private-json.mjs';
import { AppError } from '../settings.mjs';

export { readPrivateJson };
export function writePrivateJson(dir, name, value) {
  try { write(dir, name, value); }
  catch { throw new AppError(500, '无法写入 QQ 本地数据，请检查数据目录与权限。'); }
}
