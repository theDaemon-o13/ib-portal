// Системный реестр уязвимостей из seed и образец отчёта сканера для тестов с настоящей БД.
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { Actor } from '../modules/settings/common.js';
import { loadRegister, type RegisterDef } from '../modules/registers/definition.js';
import { optionByKey, vulnFields, VULN_REGISTER_KEY, type VulnFields } from '../modules/vulns/definition.js';
import { actorFor, makeUser, type Tx } from './db.js';

export const SAMPLE_NAME = 'scan-report-sample-2026-10-15.xlsx';
export const SAMPLE = readFileSync(new URL(`../../test/fixtures/${SAMPLE_NAME}`, import.meta.url));

export interface VulnFixture {
  actor: Actor;
  adminId: string;
  reg: RegisterDef;
  vf: VulnFields;
  opt: (key: keyof VulnFields, systemKey: string) => string;
  reload: () => Promise<RegisterDef>;
}

export async function vulnRegister(tx: Tx): Promise<VulnFixture> {
  const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
  const actor = await actorFor(tx, admin.id);
  const row = await tx.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY } });
  let reg = await loadRegister(tx, row.id);
  const fx: VulnFixture = {
    actor,
    adminId: admin.id,
    reg,
    vf: vulnFields(reg),
    opt: (key, systemKey) => optionByKey(fx.vf[key], systemKey),
    reload: async () => {
      reg = await loadRegister(tx, row.id);
      fx.reg = reg;
      fx.vf = vulnFields(reg);
      return reg;
    },
  };
  return fx;
}

export async function sampleBook(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(SAMPLE as unknown as ExcelJS.Buffer);
  return wb;
}

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
