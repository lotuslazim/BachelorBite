"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Flame, Zap, Utensils, Scale, Users, FileText, ArrowRight, ChevronDown, AlertTriangle, Package, Receipt, BadgeCheck, CheckCircle } from "lucide-react";
import { useFirebase, useUser, useDoc, useCollection } from "@/firebase";
import { doc, collection, query, where, Timestamp, getDoc } from "firebase/firestore";
import { useMemo, useState, useEffect, lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from 'date-fns/format';
import { getMonth } from 'date-fns/getMonth';
import { getYear } from 'date-fns/getYear';
import { startOfMonth } from 'date-fns/startOfMonth';
import { endOfMonth } from 'date-fns/endOfMonth';
import { addMonths } from 'date-fns/addMonths';
import { subMonths } from 'date-fns/subMonths';
import type { MealLog, Expense } from "@/lib/types";
import type { LeaveRecord } from "@/lib/electricity-split";
import { computeMonth, monthKeyOf, type MonthAdjustment, type MonthSettings, type SheetSettings } from "@/lib/month-calc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MonthSwitcher } from "./month-switcher";
import dynamic from 'next/dynamic';
import { Input } from "@/components/ui/input";
import { SettleUpDialog } from "@/components/settlements/SettleUpDialog";

const Dialog = dynamic(() => import('../ui/dialog').then(module => module.Dialog), { ssr: false });
const DialogContent = dynamic(() => import('../ui/dialog').then(module => module.DialogContent), { ssr: false });
const DialogHeader = dynamic(() => import('../ui/dialog').then(module => module.DialogHeader), { ssr: false });
const DialogTitle = dynamic(() => import('../ui/dialog').then(module => module.DialogTitle), { ssr: false });
const DialogTrigger = dynamic(() => import('../ui/dialog').then(module => module.DialogTrigger), { ssr: false });


// Type definitions for processed data
interface SettlementRecord {
  id?: string;
  userId: string;
  groupId?: string;
  month?: number;
  year?: number;
  settledTo: string;
  settlementMethod: string;
  settledAt?: Date | Timestamp;
}

interface ProcessedMember {
  id: string;
  name: string;
  photoURL?: string;
  meals: number;
  memberMeals: MealLog[];
  foodExpenses: number;
  otherExpenses: number;
  utilityExpensesPaid: number;
  memberUtilityExpenses: Expense[];
  electricityShare: number;
  gasShare: number;
  wifiShare: number;
  etcShare: number;
  totalPaid: number;
  isSettled?: boolean;
  settlementDetails?: SettlementRecord;
}

interface ProcessedData {
  processedMembers: ProcessedMember[];
  totalGroupFoodExpenses: number;
  totalGroupOtherExpenses: number;
  totalGroupMeals: number;
  mealRate: number;
  totalGroupExpenses: number;
  totalUtilityExpenses: number;
  otherExpensesList: Expense[];
  utilityShareByMember: Record<string, number>;
}

// Reusable utility functions
const sortByDateDesc = (a: { date: Date | Timestamp }, b: { date: Date | Timestamp }) => {
  const dateA = a.date instanceof Date ? a.date.getTime() : (a.date as Timestamp)?.toMillis();
  const dateB = b.date instanceof Date ? b.date.getTime() : (b.date as Timestamp)?.toMillis();
  return (dateB || 0) - (dateA || 0);
};

const formatDateSafe = (date: Date | Timestamp | undefined): string => {
  if (!date) return "N/A";
  const jsDate = date instanceof Date ? date : (date as Timestamp)?.toDate?.();
  return jsDate ? format(jsDate, 'MMM d, yyyy') : "N/A";
};

const formatShortDateSafe = (date: Date | Timestamp | undefined): string => {
  if (!date) return "N/A";
  const jsDate = date instanceof Date ? date : (date as Timestamp)?.toDate?.();
  return jsDate ? format(jsDate, 'MMM d') : "N/A";
};

// Empty State Component
function EmptyState({ icon: Icon, message }: { icon: React.ComponentType<any>, message: string }) {
  return (
    <div className="text-center py-8">
      <Icon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
      </div>
       <Skeleton className="h-96 w-full rounded-lg" />
    </div>
  );
}

function DataError() {
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Error Loading Summary</AlertTitle>
      <AlertDescription>
        There was a problem fetching the data for the monthly summary. Please try again later.
      </AlertDescription>
    </Alert>
  );
}

// Custom collapsible utility component
function CollapsibleUtilityItem({ 
  member 
}: { 
  member: ProcessedMember;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const utilityShare = member.electricityShare + member.gasShare + member.wifiShare;

  return (
    <div className="border-b last:border-b-0 py-2">
      <button
        className="flex justify-between items-center w-full group hover:bg-muted/50 p-2 rounded-lg transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <span className="font-medium text-sm">{member.name}</span>
        <div className="flex flex-col items-end gap-0.5 pr-2">
          <span className="font-semibold text-sm">Share: ৳{utilityShare.toFixed(2)}</span>
          <span className="text-xs text-muted-foreground">Paid: ৳{(member.utilityExpensesPaid || 0).toFixed(2)}</span>
        </div>
        <div className="w-9 p-0 flex items-center justify-center">
          <ChevronDown className={cn(
            "h-4 w-4 transition-transform duration-200",
            isExpanded ? "rotate-180" : ""
          )} />
        </div>
      </button>
      
      {isExpanded && (
        <div className="mt-2 space-y-3 px-2">
          <div className="grid grid-cols-3 gap-2">
            {[
              ["Electricity share", member.electricityShare],
              ["Gas share", member.gasShare],
              ["Wi-Fi share", member.wifiShare],
            ].map(([label, amount]) => (
              <div key={String(label)} className="rounded-md bg-muted/50 p-2">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className="text-sm font-semibold">৳{Number(amount).toFixed(2)}</p>
              </div>
            ))}
          </div>
          {member.memberUtilityExpenses?.length > 0 ? (
            <Table className="bg-muted/50 rounded">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-center w-12">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {member.memberUtilityExpenses.map((expense) => (
                  <TableRow key={expense.id}>
                    <TableCell>{formatShortDateSafe(expense.date)}</TableCell>
                    <TableCell><Badge variant="outline">{expense.category}</Badge></TableCell>
                    <TableCell className="text-right">৳{(expense.amount || 0).toFixed(2)}</TableCell>
                    <TableCell className="text-center">
                      {expense.receiptPhotoUrl ? (
                        <Suspense fallback={<Skeleton className="h-7 w-7"/>}>
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                  <Receipt className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-3xl">
                              <DialogHeader>
                                  <DialogTitle>Receipt for {expense.expenseItem}</DialogTitle>
                              </DialogHeader>
                              <div className="py-4">
                                  <img src={expense.receiptPhotoUrl} alt="Receipt" className="w-full h-auto rounded-md" />
                              </div>
                            </DialogContent>
                          </Dialog>
                        </Suspense>
                      ) : <span className="text-xs">-</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={AlertTriangle} message="No utility expenses paid by this member." />
          )}
        </div>
      )}
    </div>
  );
}

export function MonthlySummary() {
  const { firestore } = useFirebase();
  const { user: currentUser, isUserLoading: isCurrentUserLoading } = useUser();
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));

  const currentUserRef = useMemo(() => currentUser ? doc(firestore, "users", currentUser.uid) : null, [firestore, currentUser]);
  const { data: currentUserData, isLoading: isCurrentUserDataLoading, error: currentUserDataError } = useDoc(currentUserRef);

  const groupId = currentUserData?.groupId;
  const currentUserIsAdmin = currentUserData?.isAdmin ?? false;
  const currentUserName = currentUserData?.displayName || currentUser?.displayName || currentUser?.email?.split("@")[0] || "Member";


  const monthDateRange = useMemo(() => {
    return {
      start: Timestamp.fromDate(startOfMonth(currentMonth)),
      end: Timestamp.fromDate(endOfMonth(currentMonth)),
    };
  }, [currentMonth]);

  // Existing queries
  const membersQuery = useMemo(() =>
    (groupId ? collection(firestore, `groups/${groupId}/members`) : null),
    [firestore, groupId]
  );
  
  const mealsQuery = useMemo(() =>
    (groupId ? query(
      collection(firestore, `groups/${groupId}/meals`),
      where("date", ">=", monthDateRange.start),
      where("date", "<=", monthDateRange.end)
    ) : null),
    [firestore, groupId, monthDateRange]
  );

  const expensesQuery = useMemo(() =>
    (groupId ? query(
      collection(firestore, `groups/${groupId}/expenses`),
      where("date", ">=", monthDateRange.start),
      where("date", "<=", monthDateRange.end)
    ) : null),
    [firestore, groupId, monthDateRange]
  );
  
  const settlementsQuery = useMemo(() =>
    (groupId ? query(
      collection(firestore, `groups/${groupId}/settlements`),
      where("month", "==", getMonth(currentMonth) + 1),
      where("year", "==", getYear(currentMonth))
    ) : null),
    [firestore, groupId, currentMonth]
  );

  const usersQuery = useMemo(() =>
    collection(firestore, "users"),
    [firestore]
  );

  const leavesQuery = useMemo(() =>
    (groupId ? collection(firestore, `groups/${groupId}/leaves`) : null),
    [firestore, groupId]
  );
  const { data: leavesData, isLoading: areLeavesLoading } = useCollection<LeaveRecord>(leavesQuery);

  const adjustmentsQuery = useMemo(() =>
    (groupId ? query(collection(firestore, `groups/${groupId}/adjustments`), where("monthKey", "==", monthKeyOf(monthDateRange.start.toDate()))) : null),
    [firestore, groupId, monthDateRange]
  );
  const { data: adjustmentsData } = useCollection<MonthAdjustment>(adjustmentsQuery);

  const sheetSettingsRef = useMemo(() =>
    (groupId ? doc(firestore, `groups/${groupId}/sheetSettings`, "default") : null),
    [firestore, groupId]
  );
  const monthSettingsRef = useMemo(() =>
    (groupId ? doc(firestore, `groups/${groupId}/monthSettings`, monthKeyOf(monthDateRange.start.toDate())) : null),
    [firestore, groupId, monthDateRange]
  );
  const { data: sheetSettingsData } = useDoc<SheetSettings>(sheetSettingsRef);
  const { data: monthSettingsData } = useDoc<MonthSettings>(monthSettingsRef);

  const { data: membersData, isLoading: areMembersLoading, error: membersError } = useCollection(membersQuery);
  const { data: mealsData, isLoading: areMealsLoading, error: mealsError } = useCollection<MealLog>(mealsQuery);
  const { data: expensesData, isLoading: areExpensesLoading, error: expensesError } = useCollection<Expense>(expensesQuery);
  const { data: settlementsData, isLoading: areSettlementsLoading, error: settlementsError } = useCollection<SettlementRecord>(settlementsQuery);
  // Names/photos: read each member's own user doc (listing all users is blocked by Rules).
  const [memberProfiles, setMemberProfiles] = useState<Record<string, { displayName?: string; photoURL?: string; email?: string }>>({});

  useEffect(() => {
    if (!membersData) return;
    let cancelled = false;

    Promise.all(
      membersData.map(async (member: any) => {
        try {
          const snap = await getDoc(doc(firestore, "users", member.id));
          return snap.exists() ? { id: member.id, ...(snap.data() as any) } : null;
        } catch {
          return null;
        }
      })
    ).then((profiles) => {
      if (cancelled) return;
      const map: Record<string, { displayName?: string; photoURL?: string; email?: string }> = {};
      profiles.forEach((profile) => {
        if (profile) map[profile.id] = profile;
      });
      setMemberProfiles(map);
    });

    return () => {
      cancelled = true;
    };
  }, [membersData, firestore]);

  const usersData = useMemo(() => {
    if (!membersData) return null;
    return membersData.map((member: any) => {
      const profile = memberProfiles[member.id];
      return {
        id: member.id,
        displayName: profile?.displayName || member.displayName || member.userName,
        photoURL: profile?.photoURL || member.photoURL,
        email: profile?.email || member.email,
      };
    });
  }, [membersData, memberProfiles]);
  const areUsersLoading = false;
  const usersError = null;

  const isAnyLoading = isCurrentUserLoading || isCurrentUserDataLoading || (!!groupId && (areMembersLoading || areMealsLoading || areExpensesLoading || areUsersLoading || areSettlementsLoading || areLeavesLoading));
  const hasAnyErrors = currentUserDataError || membersError || mealsError || expensesError || usersError || settlementsError;

  const handleMonthChange = (direction: "next" | "prev") => {
    setCurrentMonth(prev => direction === 'next' ? addMonths(prev, 1) : subMonths(prev, 1));
  }

  const processedData = useMemo((): ProcessedData | null => {
    if (!membersData || !mealsData || !expensesData || !usersData || !settlementsData) {
      return null;
    }

    const userMap = usersData.reduce((acc, userDoc) => {
      acc[userDoc.id] = {
        displayName: userDoc.displayName,
        photoURL: userDoc.photoURL,
        email: userDoc.email
      };
      return acc;
    }, {} as Record<string, { displayName?: string; photoURL?: string; email?: string }>);

    const mealsByUser = mealsData.reduce((acc, meal) => {
      acc[meal.userId] = [...(acc[meal.userId] || []), meal];
      return acc;
    }, {} as Record<string, MealLog[]>);

    const expensesByUser = expensesData.reduce((acc, expense) => {
      acc[expense.userId] = [...(acc[expense.userId] || []), expense];
      return acc;
    }, {} as Record<string, Expense[]>);

    const settlementsByUser = settlementsData.reduce((acc, settlement) => {
      acc[settlement.userId] = settlement;
      return acc;
    }, {} as Record<string, SettlementRecord>);


    const monthStart = monthDateRange.start.toDate();
    const monthEnd = monthDateRange.end.toDate();
    const asDate = (value: any): Date | null => {
      if (!value) return null;
      if (value instanceof Date) return value;
      if (typeof value.toDate === "function") return value.toDate();
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    // Use only members who were active during this month, matching the
    // Admin sheet and Settlement History denominator.
    const activeMembers = membersData.filter((member: any) => {
      const joinedAt = asDate(member.joinedAt);
      const leftAt = asDate(member.leftAt);
      return (!joinedAt || joinedAt <= monthEnd) && (!leftAt || leftAt >= monthStart);
    });

    const monthCalc = computeMonth({
      members: activeMembers,
      meals: mealsData,
      expenses: expensesData,
      leaves: leavesData ?? [],
      adjustments: adjustmentsData ?? [],
      monthStart,
      monthEnd,
      leaveCategories: sheetSettingsData?.leaveCategories,
      minLeaveDays: sheetSettingsData?.minLeaveDays,
      splitMembers: monthSettingsData?.splitMembers,
    });

    const processedMembers = activeMembers.map((member: any) => {
      const userDetails = userMap[member.id];
      const memberMeals = (mealsByUser[member.id] || []).sort(sortByDateDesc);
      const memberExpenses = expensesByUser[member.id] || [];
      const r = monthCalc.byMember[member.id];
      const memberUtilityExpenses = memberExpenses
        .filter(e => e.category === "Electricity" || e.category === "Gas" || e.category === "Wi-Fi")
        .sort(sortByDateDesc);

      return {
        id: member.id,
        name: userDetails?.displayName || userDetails?.email?.split("@")[0] || memberMeals[0]?.userName || memberExpenses[0]?.userName || "Unnamed Member",
        photoURL: userDetails?.photoURL,
        meals: r?.meals ?? 0,
        memberMeals,
        foodExpenses: r?.bazar ?? 0,
        otherExpenses: r?.etc ?? 0,
        utilityExpensesPaid: r?.utilities ?? 0,
        memberUtilityExpenses,
        electricityShare: r?.electricityShare ?? 0,
        gasShare: r?.gasShare ?? 0,
        wifiShare: r?.wifiShare ?? 0,
        etcShare: r?.etcShare ?? 0,
        totalPaid: memberExpenses.reduce((sum, e) => sum + (e.amount || 0), 0) + (r?.paidAdjustment ?? 0),
        isSettled: !!settlementsByUser[member.id],
        settlementDetails: settlementsByUser[member.id],
      } as ProcessedMember;
    });

    const totalGroupFoodExpenses = monthCalc.foodTotal;
    const totalGroupOtherExpenses = processedMembers.reduce((sum, member) => sum + member.otherExpenses, 0);
    const totalGroupMeals = monthCalc.totalMeals;
    const mealRate = monthCalc.mealRate;
    const totalUtilityExpenses = processedMembers.reduce(
      (sum, member) => sum + (monthCalc.byMember[member.id]?.utilities ?? 0),
      0
    );
    const totalGroupExpenses = processedMembers.reduce(
      (sum, member) => sum + (monthCalc.byMember[member.id]?.total ?? 0),
      0
    );
    const otherExpensesList = expensesData.filter(e => e.category === "Other").sort(sortByDateDesc);
    const utilityShareByMember: Record<string, number> = {};
    processedMembers.forEach((member) => {
      utilityShareByMember[member.id] = monthCalc.byMember[member.id]?.settlementShare ?? 0;
    });

    return {
      processedMembers,
      totalGroupFoodExpenses,
      totalGroupOtherExpenses,
      totalGroupMeals: monthCalc.totalMeals,
      mealRate: monthCalc.mealRate || mealRate || 0,
      totalGroupExpenses: totalGroupExpenses || 0,
      totalUtilityExpenses: totalUtilityExpenses || 0,
      otherExpensesList,
      utilityShareByMember
    };
  }, [membersData, mealsData, expensesData, usersData, settlementsData, leavesData, adjustmentsData, sheetSettingsData, monthSettingsData, monthDateRange]);

  if (isAnyLoading) {
    return <SummarySkeleton />;
  }

  if (hasAnyErrors) {
    return <DataError />;
  }
  
  if (!processedData) {
      return <SummarySkeleton />;
  }

  const {
      processedMembers,
      totalGroupFoodExpenses,
      totalGroupOtherExpenses,
      totalGroupMeals,
      mealRate,
      totalGroupExpenses,
      totalUtilityExpenses,
      otherExpensesList,
      utilityShareByMember
  } = processedData;

  const balanceOf = (member: ProcessedMember) => {
    const share = utilityShareByMember[member.id] ?? member.meals * mealRate;
    return member.totalPaid - share;
  };
  const settleMembers = processedMembers.map((m) => ({ id: m.id, name: m.name, balance: balanceOf(m) }));

  const monthForSettlement = getMonth(currentMonth) + 1;
  const yearForSettlement = getYear(currentMonth);

  return (
    <div className="space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
                <h2 className="text-xl md:text-2xl font-bold font-headline">Monthly Summary</h2>
                <p className="text-sm text-muted-foreground">An overview of your group's activity for the selected month.</p>
            </div>
            <MonthSwitcher 
                currentDate={currentMonth}
                onMonthChange={handleMonthChange}
            />
        </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="flex flex-col">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl"><Utensils/> Food & Meals</CardTitle>
            </CardHeader>
            <CardContent className="flex-grow">
               <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-sm text-muted-foreground">Food & Groceries</p>
                  <p className="text-2xl font-bold">৳{(totalGroupFoodExpenses || 0).toFixed(0)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Meals</p>
                  <p className="text-2xl font-bold">{totalGroupMeals || 0}</p>
                </div>
               </div>
            </CardContent>
            <CardContent>
                <div className="text-center p-3 bg-primary/10 rounded-lg">
                  <p className="text-sm font-medium text-primary/80">Calculated Meal Rate</p>
                  <p className="text-3xl font-bold text-primary">৳{(mealRate || 0).toFixed(2)} / meal</p>
              </div>
            </CardContent>
        </Card>
        
       <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl"><Zap/> Utilities Breakdown</CardTitle>
           <CardDescription>A summary of monthly utility payments.</CardDescription>
        </CardHeader>
        <CardContent className="flex-grow space-y-4">
             <div>
                <p className="text-sm text-muted-foreground">Total Utility Expenses</p>
                <p className="text-2xl font-bold">৳{(totalUtilityExpenses || 0).toFixed(0)}</p>
            </div>
            <div className="space-y-2 pt-2">
                <p className="text-sm font-medium">Member Contributions</p>
                 {processedMembers.length > 0 ? (
                    processedMembers.map((member) => (
                    <CollapsibleUtilityItem 
                        key={member.id} 
                        member={member}
                    />
                    ))
                ) : (
                    <EmptyState icon={Users} message="No utility data available." />
                )}
            </div>
        </CardContent>
      </Card>
       <Card className="flex flex-col">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl"><Package/> Other Expenses</CardTitle>
                 <CardDescription>A summary of other expenses.</CardDescription>
            </CardHeader>
            <CardContent className="flex-grow space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Total "Other" Expenses</p>
                  <p className="text-2xl font-bold">৳{(totalGroupOtherExpenses || 0).toFixed(0)}</p>
                </div>
                 <Collapsible>
                    <CollapsibleTrigger asChild>
                        <Button variant="outline" size="sm" className="w-full group">
                            Show Breakdown 
                            <ChevronDown className="h-4 w-4 ml-2 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                        </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-4">
                        {otherExpensesList.length > 0 ? (
                           <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Date</TableHead>
                                        <TableHead>Member</TableHead>
                                        <TableHead>Item</TableHead>
                                        <TableHead className="text-right">Amount</TableHead>
                                        <TableHead className="text-center">Receipt</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {otherExpensesList.map(expense => {
                                      const userDetails = processedMembers.find(m => m.id === expense.userId);
                                      return (
                                        <TableRow key={expense.id}>
                                            <TableCell>{formatShortDateSafe(expense.date)}</TableCell>
                                            <TableCell>{userDetails?.name || 'Unknown Member'}</TableCell>
                                            <TableCell>{expense.expenseItem}</TableCell>
                                            <TableCell className="text-right">৳{expense.amount.toFixed(2)}</TableCell>
                                            <TableCell className="text-center">
                                                {expense.receiptPhotoUrl ? (
                                                  <Suspense fallback={<Skeleton className="h-7 w-7"/>}>
                                                    <Dialog>
                                                        <DialogTrigger asChild>
                                                            <Button variant="ghost" size="icon" className="h-7 w-7">
                                                                <Receipt className="h-4 w-4" />
                                                            </Button>
                                                        </DialogTrigger>
                                                        <DialogContent className="max-w-3xl">
                                                          <DialogHeader>
                                                              <DialogTitle>Receipt for {expense.expenseItem}</DialogTitle>
                                                          </DialogHeader>
                                                          <div className="py-4">
                                                              <img src={expense.receiptPhotoUrl} alt="Receipt" className="w-full h-auto rounded-md" />
                                                          </div>
                                                        </DialogContent>
                                                    </Dialog>
                                                  </Suspense>
                                                ) : <span className="text-xs">-</span>}
                                            </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                </TableBody>
                           </Table>
                        ) : (
                            <div className="text-center text-muted-foreground py-4 text-sm">
                                No "Other" expenses logged for this month.
                            </div>
                        )}
                    </CollapsibleContent>
                 </Collapsible>
            </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden border-[#5eead4]/15 bg-[linear-gradient(155deg,rgba(20,54,45,0.98),rgba(12,35,32,0.98))] shadow-[0_18px_44px_rgba(0,0,0,0.2)]">
        <CardHeader className="space-y-1 p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em] text-[#f4f7f5]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#5eead4]/20 bg-[#5eead4]/10 text-[#79e4d2]">
              <Scale className="h-4 w-4" />
            </span>
            Final Settlement
          </CardTitle>
          <CardDescription className="text-[12px] leading-5 text-[#b4c8c0]">
            Monthly contributions, shares, and balances at a glance.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3 p-3 pt-2">
          {processedMembers.map((member) => {
            // This is the full member share from the shared calculation engine.
            const memberShare = utilityShareByMember[member.id] ?? member.meals * mealRate;
            const balance = member.totalPaid - memberShare;
            const hasCredit = balance >= 0;

            return (
              <Collapsible
                key={member.id}
                className="group overflow-hidden rounded-2xl border border-[#5eead4]/14 bg-[#102d27]/85"
              >
                <div className="p-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 shrink-0 border border-[#f4d35e]/45">
                      <AvatarImage src={member.photoURL} />
                      <AvatarFallback>{member.name.charAt(0)}</AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-[#f4f7f5]">
                        {member.name}
                      </p>
                      <p
                        className={cn(
                          "mt-0.5 text-[13px] font-semibold",
                          hasCredit ? "text-[#6ee7b7]" : "text-[#f2a6a6]"
                        )}
                      >
                        {hasCredit ? "Gets" : "Owes"}: ৳{Math.abs(balance).toFixed(2)}
                      </p>
                    </div>

                    {member.isSettled && (
                      <Badge className="border border-[#6ee7b7]/25 bg-[#6ee7b7]/10 px-2 py-1 text-[10px] font-medium text-[#86efc3] hover:bg-[#6ee7b7]/10">
                        <CheckCircle className="mr-1 h-3 w-3" />
                        Settled
                      </Badge>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-white/7 bg-[#0b241f]/72 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.08em] text-[#8fb0a5]">
                        Total Paid
                      </p>
                      <p className="mt-0.5 text-[13px] font-semibold text-[#eef5f1]">
                        ৳{member.totalPaid.toFixed(2)}
                      </p>
                    </div>

                    <div className="rounded-xl border border-white/7 bg-[#0b241f]/72 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.08em] text-[#8fb0a5]">
                        Total Share
                      </p>
                      <p className="mt-0.5 text-[13px] font-semibold text-[#eef5f1]">
                        ৳{memberShare.toFixed(2)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    {!member.isSettled && (
                      <SettleUpDialog
                        member={{ id: member.id, name: member.name, balance }}
                        amountDue={-balance}
                        month={monthForSettlement}
                        year={yearForSettlement}
                        groupId={groupId!}
                        currentUserId={currentUser!.uid}
                        currentUserName={currentUserName}
                        members={settleMembers}
                        currentUserIsAdmin={currentUserIsAdmin}
                      />
                    )}

                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className="h-9 flex-1 rounded-lg border border-[#5eead4]/12 bg-[#153a33] px-3 text-[12px] font-medium text-[#d8ebe4] hover:bg-[#19463d] hover:text-white group-data-[state=open]:bg-[#19463d]"
                      >
                        View Details
                        <ChevronDown className="ml-2 h-3.5 w-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                </div>

                <CollapsibleContent>
                  <div className="border-t border-[#5eead4]/12 bg-[linear-gradient(145deg,rgba(17,54,47,0.98),rgba(12,40,48,0.98))] p-3">
                    <h4 className="mb-2 text-[13px] font-semibold text-[#f2f7f5]">
                      Details for {member.name}
                    </h4>

                    {member.isSettled && member.settlementDetails && (
                      <Alert className="mb-3 border-[#6ee7b7]/25 bg-[#6ee7b7]/8 text-[#d9f9eb]">
                        <BadgeCheck className="h-4 w-4 !text-[#6ee7b7]" />
                        <AlertTitle className="text-[12px] font-semibold">
                          Settlement confirmed
                        </AlertTitle>
                        <AlertDescription className="text-[11px] leading-5 text-[#bfe9d8]">
                          Paid to <span className="font-semibold text-white">{member.settlementDetails.settledTo}</span> via {member.settlementDetails.settlementMethod} on {formatDateSafe(member.settlementDetails.settledAt)}.
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                      {[
                        ["Total Meals", member.meals],
                        ["Food", `৳${member.foodExpenses.toFixed(2)}`],
                        ["Utilities", `৳${member.utilityExpensesPaid.toFixed(2)}`],
                        ["Other", `৳${member.otherExpenses.toFixed(2)}`],
                      ].map(([label, value]) => (
                        <div
                          key={String(label)}
                          className="rounded-xl border border-[#5eead4]/12 bg-[#0b2728]/72 px-2.5 py-2"
                        >
                          <p className="text-[10px] text-[#8fb0ac]">{label}</p>
                          <p className="mt-0.5 text-[12px] font-semibold text-[#edf6f3]">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[
                        ["Electricity share", member.electricityShare],
                        ["Gas share", member.gasShare],
                        ["Wi-Fi share", member.wifiShare],
                        ["ETC share", member.etcShare],
                      ].map(([label, amount]) => (
                        <div key={String(label)} className="rounded-xl border border-[#5eead4]/12 bg-[#0b2728]/72 px-2.5 py-2">
                          <p className="text-[10px] text-[#8fb0ac]">{label}</p>
                          <p className="mt-0.5 text-[12px] font-semibold text-[#edf6f3]">৳{Number(amount).toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </CardContent>

        <CardFooter className="border-t border-[#5eead4]/12 bg-[#081d19]/88 p-3">
          <div className="w-full overflow-hidden rounded-2xl border border-[#d9bd68]/18 bg-[#0a211c]">
            {[
              ["Food", totalGroupFoodExpenses, false],
              ["Utilities", totalUtilityExpenses, false],
              ["Other", totalGroupOtherExpenses, false],
              ["Grand Total", totalGroupExpenses, true],
            ].map(([label, value, highlighted], index) => (
              <div
                key={String(label)}
                className={cn(
                  "flex min-h-11 items-center justify-between gap-4 px-3.5 py-2.5",
                  index < 3 && "border-b border-white/[0.07]",
                  highlighted && "bg-[linear-gradient(90deg,rgba(244,211,94,0.11),rgba(244,211,94,0.035))]"
                )}
              >
                <span
                  className={cn(
                    "text-[12px] font-medium",
                    highlighted ? "text-[#f1d47a]" : "text-[#c8bfa8]"
                  )}
                >
                  {label}
                </span>

                <span
                  className={cn(
                    "text-[13px] font-semibold tabular-nums",
                    highlighted ? "text-[#ffd85f]" : "text-[#f2eee4]"
                  )}
                >
                  ৳{Number(value).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
