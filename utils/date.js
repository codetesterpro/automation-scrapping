// utils/date.js
import dayjsBase from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore.js";

// extend semua plugin di 1 tempat
dayjsBase.extend(isSameOrBefore);
dayjsBase.extend(utc);
dayjsBase.extend(timezone);

const ZONE = "Asia/Jakarta";

/**
 * Menghitung tanggal start & end berdasarkan:
 * - DEFAULT: H-4 s/d H-1 (WIB)
 * - Override via env:
 *    START_DATE (YYYY-MM-DD)
 *    END_DATE   (YYYY-MM-DD)
 */
export function getDateRangeFromEnv() {
  const startDateStr =
    process.env.START_DATE ||
    dayjsBase().tz(ZONE).subtract(4, "day").format("YYYY-MM-DD");

  const endDateStr =
    process.env.END_DATE ||
    dayjsBase().tz(ZONE).subtract(1, "day").format("YYYY-MM-DD");

  const startDate = dayjsBase.tz(startDateStr, ZONE).startOf("day");
  const endDate = dayjsBase.tz(endDateStr, ZONE).endOf("day");

  return { startDate, endDate, zone: ZONE };
}

// export dayjs yang sudah di-extend plugin, biar dipakai di file lain
export { dayjsBase as dayjs, ZONE };
