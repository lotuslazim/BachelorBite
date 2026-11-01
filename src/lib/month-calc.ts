/*
 * Shared month calculation for the Admin sheet, Monthly Summary and
 * Settlement History.
 *
 * ADMIN SHEET = what each member entered (no splitting):
 *   Meals     = meals the member logged (+ admin change)
 *   Bazar     = Food & Groceries the member entered (+ admin change)
 *   Utilities = Electricity + Gas the member entered (+ admin change)
 *   Wi-Fi     = Wi-Fi the member entered (+ admin change)
 *   ETC       = any other cost the member entered (+ admin change)
 *   Total     = Bazar + Utilities + Wi-Fi + ETC
 *
 * SETTLEMENT = who owes whom (splitting happens only here):
 *   meal rate   = all Bazar / all meals, meal cost = meal rate x meals
 *   bills       = Electricity / Gas / Wi-Fi totals split among the chosen
 *                 members (default all), by days at home if the leave
 *                 discount is on for that bill
 *   ETC         = shared equally among all active members by default;
 *                 the admin can restrict it to selected members for that month
 *   share       = meal cost + bill shares + ETC share
 *   paid        = everything the member entered + admin changes
 */
import type { Expense, MealLog } from "./types";
import { isMemberHomeOnDay, type LeaveRecord, type MemberPresenceInfo } from "./electricity-split";

export type AdjustField = "meals" | "bazar" | "utilities" | "wifi" | "etc";
export const ADJUST_FIELDS: AdjustField[] = ["meals", "bazar", "utilities", "wifi", "etc"];
export type MoneyField = Exclude<AdjustField, "meals">;

export const BILL_TYPES = ["Electricity", "Gas", "Wi-Fi", "Other"] as const;
export type BillType = (typeof BILL_TYPES)[number];
export const LEAVE_BILL_TYPES = ["Electricity", "Gas", "Wi-Fi"] as const;

export interface MonthAdjustment {
  id?: string;
  userId: string;
  monthKey: string;
  field: AdjustField;
  delta: number;
  reason?: string;
  createdByName?: string;
  createdAt?: unknown;
}

export interface SheetSettings {
  leaveCategories?: string[];
  /*
   * অ্যাডমিনের নিয়ম: অন্তত এত দিনের ছুটি হলে তবেই বিলে ছাড় পাবে।
   * না থাকলে ১ (আগের মতো, যেকোনো ছুটি গোনা হয়)।
   */
  minLeaveDays?: number;
}

export const DEFAULT_MIN_LEAVE_DAYS = 1;
export const MAX_MIN_LEAVE_DAYS = 31;

const leaveToDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
};

/*
 * ছুটি মোট কত দিনের (মাস পেরিয়ে গেলেও পুরোটা)।
 * endDate = ফেরার দিন, তাই দিন = endDate - startDate।
 * চলমান ছুটি (endDate নেই) হলে আজ পর্যন্ত যত দিন হয়েছে।
 */
export const leaveLengthDays = (
  leave: { startDate: unknown; endDate?: unknown },
  today: Date = new Date()
): number => {
  const start = leaveToDate(leave.startDate);
  if (!start) return 0;
  const end = leaveToDate(leave.endDate);
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const until = end
    ? new Date(end.getFullYear(), end.getMonth(), end.getDate())
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return Math.max(0, Math.round((until.getTime() - from.getTime()) / 86_400_000));
};

export const normalizeMinLeaveDays = (value: unknown): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MIN_LEAVE_DAYS;
  return Math.min(n, MAX_MIN_LEAVE_DAYS);
};

/* এই ছুটিটা কি বিলের ছাড়ের জন্য গোনা হবে? */
export const leaveCounts = (
  leave: { startDate: unknown; endDate?: unknown },
  minLeaveDays: unknown,
  today?: Date
): boolean => {
  const min = normalizeMinLeaveDays(minLeaveDays);
  return min <= 1 || leaveLengthDays(leave, today) >= min;
};

export interface MonthSettings {
  locked?: boolean;
  splitMembers?: Partial<Record<BillType, string[] | null>>;
}

export interface MemberMonthResult {
  meals: number;
  bazar: number;
  utilities: number;
  wifi: number;
  etc: number;
  total: number;
  entryCount: Record<AdjustField, number>;
  adjustments: Record<AdjustField, number>;
  mealCost: number;
  // Individual contribution amounts are exposed for the Monthly Summary
  // breakdown as well as being included in settlementShare.
  electricityShare: number;
  gasShare: number;
  wifiShare: number;
  etcShare: number;
  settlementShare: number;
  paidAdjustment: number;
  daysHome: number;
}

export interface MonthResult {
  byMember: Record<string, MemberMonthResult>;
  mealRate: number;
  totalMeals: number;
  foodTotal: number;
}

export const DEFAULT_LEAVE_CATEGORIES = ["Electricity"];

/*
 * Fix: কিছু জায়গা থেকে Date-এর বদলে Firestore Timestamp আসত।
 * Timestamp-এ getFullYear() নেই, তাই Report পেজ crash করত
 * ("e.getFullYear is not a function")। এখন দুটোই চলবে।
 */
export const monthKeyOf = (input: Date | { toDate: () => Date }) => {
  const date = input instanceof Date ? input : input.toDate();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

/* Which sheet column an expense category belongs to. */
export const fieldOfCategory = (category: string): MoneyField => {
  if (category === "Food & Groceries") return "bazar";
  if (category === "Electricity" || category === "Gas") return "utilities";
  if (category === "Wi-Fi") return "wifi";
  return "etc";
};

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export function computeMonth(params: {
  members: MemberPresenceInfo[];
  meals: MealLog[];
  expenses: Expense[];
  leaves?: LeaveRecord[];
  adjustments?: MonthAdjustment[];
  monthStart: Date;
  monthEnd: Date;
  leaveCategories?: string[];
  splitMembers?: MonthSettings["splitMembers"];
  minLeaveDays?: number;
}): MonthResult {
  const {
    members,
    meals,
    expenses,
    leaves = [],
    adjustments = [],
    leaveCategories = DEFAULT_LEAVE_CATEGORIES,
    splitMembers = {},
  } = params;

  // Fix: Timestamp এলেও Date-এ রূপান্তর, যাতে crash না করে।
  const asDate = (value: unknown): Date =>
    value instanceof Date ? value : (value as { toDate: () => Date }).toDate();
  const monthStart = asDate(params.monthStart);
  const monthEnd = asDate(params.monthEnd);

  const ids = members.map((m) => m.id);
  const zero = () => Object.fromEntries(ids.map((id) => [id, 0])) as Record<string, number>;
  const blank = (): Record<AdjustField, number> => ({ meals: 0, bazar: 0, utilities: 0, wifi: 0, etc: 0 });

  /* ---- admin changes ---- */
  const adj: Record<string, Record<AdjustField, number>> = {};
  ids.forEach((id) => (adj[id] = blank()));
  adjustments.forEach((a) => {
    if (!adj[a.userId] || !ADJUST_FIELDS.includes(a.field)) return;
    adj[a.userId][a.field] += Number(a.delta) || 0;
  });

  /* ---- what each member entered ---- */
  const entered: Record<string, Record<AdjustField, number>> = {};
  const count: Record<string, Record<AdjustField, number>> = {};
  const elecEntered = zero();
  const gasEntered = zero();
  ids.forEach((id) => {
    entered[id] = blank();
    count[id] = blank();
  });
  meals.forEach((meal) => {
    if (!entered[meal.userId]) return;
    entered[meal.userId].meals += Number(meal.mealNumber ?? 1) || 0;
    count[meal.userId].meals += 1;
  });
  expenses.forEach((e) => {
    if (!entered[e.userId]) return;
    const amount = Number(e.amount) || 0;
    const field = fieldOfCategory(e.category);
    entered[e.userId][field] += amount;
    count[e.userId][field] += 1;
    if (e.category === "Electricity") elecEntered[e.userId] += amount;
    if (e.category === "Gas") gasEntered[e.userId] += amount;
  });

  const col = (id: string, f: AdjustField) => entered[id][f] + adj[id][f];

  /* ---- days at home (for the leave discount) ---- */
  /* অ্যাডমিনের নিয়মের চেয়ে ছোট ছুটি বাদ (সে বাসায় ছিল ধরা হবে)। */
  const countedLeaves = leaves.filter((l) => leaveCounts(l, params.minLeaveDays));
  const leavesByUser = countedLeaves.reduce((acc, l) => {
    (acc[l.userId] = acc[l.userId] || []).push(l);
    return acc;
  }, {} as Record<string, LeaveRecord[]>);
  const daysHome = zero();
  const last = dayStart(monthEnd);
  for (let d = dayStart(monthStart); d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    members.forEach((m) => {
      if (isMemberHomeOnDay(m, leavesByUser[m.id] || [], d)) daysHome[m.id] += 1;
    });
  }

  /* ---- settlement: split a bill total among its sharers ---- */
  const split = (billType: BillType, total: number) => {
    const out = zero();
    if (!total) return out;
    const chosen = splitMembers?.[billType];
    let sharers = Array.isArray(chosen) && chosen.length > 0 ? ids.filter((id) => chosen.includes(id)) : ids;
    if (sharers.length === 0) sharers = ids;
    if (sharers.length === 0) return out;
    const useLeave = billType !== "Other" && leaveCategories.includes(billType);
    const totalDays = sharers.reduce((s, id) => s + daysHome[id], 0);
    sharers.forEach((id) => {
      out[id] = useLeave && totalDays > 0 ? (total * daysHome[id]) / totalDays : total / sharers.length;
    });
    return out;
  };

  const sumIds = (fn: (id: string) => number) => ids.reduce((s, id) => s + fn(id), 0);
  /* admin Utilities changes count as Electricity */
  const elecShare = split("Electricity", sumIds((id) => elecEntered[id] + adj[id].utilities));
  const gasShare = split("Gas", sumIds((id) => gasEntered[id]));
  const wifiShare = split("Wi-Fi", sumIds((id) => col(id, "wifi")));
  // ETC is shared by all active members by default. If the admin selects
  // specific members, split() restricts the share to that selected group.
  const etcShare = split("Other", sumIds((id) => col(id, "etc")));

  const mealCount = zero();
  ids.forEach((id) => (mealCount[id] = Math.max(0, col(id, "meals"))));
  const totalMeals = sumIds((id) => mealCount[id]);
  const foodTotal = sumIds((id) => col(id, "bazar"));
  const mealRate = totalMeals > 0 ? foodTotal / totalMeals : 0;

  const byMember: Record<string, MemberMonthResult> = {};
  ids.forEach((id) => {
    const bazar = col(id, "bazar");
    const utilities = col(id, "utilities");
    const wifi = col(id, "wifi");
    const etc = col(id, "etc");
    const mealCost = mealRate * mealCount[id];
    byMember[id] = {
      meals: mealCount[id],
      bazar,
      utilities,
      wifi,
      etc,
      total: bazar + utilities + wifi + etc,
      entryCount: count[id],
      adjustments: adj[id],
      mealCost,
      // Keep the category-level values available to the UI. The summary
      // reads these fields separately; settlementShare is their combined total.
      electricityShare: elecShare[id],
      gasShare: gasShare[id],
      wifiShare: wifiShare[id],
      etcShare: etcShare[id],
      settlementShare: mealCost + elecShare[id] + gasShare[id] + wifiShare[id] + etcShare[id],
      paidAdjustment: adj[id].bazar + adj[id].utilities + adj[id].wifi + adj[id].etc,
      daysHome: daysHome[id],
    };
  });

  return { byMember, mealRate, totalMeals, foodTotal };
}
