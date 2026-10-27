// Системный «Реестр инцидентов» (этап 8): источник KPI «Инциденты за 30 дней».
// Стартовый реестр помечается системным один раз в seed (seed/registers.ts).
export const INCIDENT_REGISTER_KEY = 'incidents';
/** Поле «Дата выявления»: системное, по нему считается KPI. */
export const INCIDENT_DATE_KEY = 'detected';
