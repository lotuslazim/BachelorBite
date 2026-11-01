"use client";

import { useMemo, useState, useEffect } from "react";
import { useFirebase, useUser, useDoc, useCollection } from "@/firebase";
import { doc, collection, query, where, getDocs, getDoc, orderBy, limit } from "firebase/firestore";
import { format, getMonth, getYear, startOfMonth, endOfMonth, addMonths, subMonths } from "date-fns";
import type { MealLog, Expense, Settlement, Member } from "@/lib/types";
import type { LeaveRecord } from "@/lib/electricity-split";
import { computeMonth, monthKeyOf, type MonthAdjustment, type MonthSettings, type SheetSettings } from "@/lib/month-calc";
import { WelcomeCard } from "@/components/app/welcome-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChevronDown, Scale, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { SettleUpDialog } from "@/components/settlements/SettleUpDialog";

interface ProcessedMember {
  id: string;
  name: string;
  photoURL?: string;
  totalPaid: number;
  totalShare: number;
  electricityShare: number;
  gasShare: number;
  wifiShare: number;
  etcShare: number;
  balance: number;
  isSettled?: boolean;
  settlementDetails?: Settlement;
}

interface MonthlyRecord {
  month: Date;
  processedMembers: ProcessedMember[];
  totalGroupExpenses: number;
  mealRate: number;
}

const toJsDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

function HistorySkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-7 w-48" />
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function SettlementHistory() {
  const { firestore } = useFirebase();
  const { user: currentUser, isUserLoading } = useUser();
  const [history, setHistory] = useState<MonthlyRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  const currentUserRef = useMemo(() => currentUser ? doc(firestore, "users", currentUser.uid) : null, [firestore, currentUser]);
  const { data: currentUserData, isLoading: isCurrentUserDataLoading } = useDoc(currentUserRef);
  const groupId = currentUserData?.groupId;
  const currentUserIsAdmin = currentUserData?.isAdmin ?? false;
  const currentUserName = currentUserData?.displayName || currentUser?.displayName || currentUser?.email?.split("@")[0] || "Member";

  useEffect(() => {
    if (!groupId) {
        setIsLoadingHistory(false);
        return;
    };

    const fetchHistory = async () => {
        setIsLoadingHistory(true);
        const monthlyRecords: MonthlyRecord[] = [];
        
        const groupCreationQuery = query(collection(firestore, `groups/${groupId}/members`), orderBy("joinedAt", "asc"), limit(1));
        const groupCreationSnapshot = await getDocs(groupCreationQuery);
        const firstJoinDate = groupCreationSnapshot.docs[0]?.data().joinedAt.toDate() || new Date();
        
        let leavesData: LeaveRecord[] = [];
        try {
            const leavesSnapshot = await getDocs(collection(firestore, `groups/${groupId}/leaves`));
            leavesData = leavesSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as LeaveRecord));
        } catch (error) {
            console.error("Could not load leave records:", error);
        }

        // Names/photos: read each member's own user doc (listing all users is blocked by Rules).
        const profileMap: Record<string, any> = {};
        try {
            const allMembersSnapshot = await getDocs(collection(firestore, `groups/${groupId}/members`));
            await Promise.all(allMembersSnapshot.docs.map(async (memberDoc) => {
                const memberData = memberDoc.data() as any;
                let profile: any = null;
                try {
                    const snap = await getDoc(doc(firestore, "users", memberDoc.id));
                    profile = snap.exists() ? snap.data() : null;
                } catch {
                    profile = null;
                }
                profileMap[memberDoc.id] = {
                    id: memberDoc.id,
                    displayName: profile?.displayName || memberData.displayName || memberData.userName,
                    photoURL: profile?.photoURL || memberData.photoURL,
                    email: profile?.email || memberData.email,
                };
            }));
        } catch (error) {
            console.error("Could not load member profiles:", error);
        }

        let allAdjustments: MonthAdjustment[] = [];
        try {
            const adjSnapshot = await getDocs(collection(firestore, `groups/${groupId}/adjustments`));
            allAdjustments = adjSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as MonthAdjustment));
        } catch (error) {
            console.error("Could not load adjustments:", error);
        }

        let sheetSettings: SheetSettings | null = null;
        const monthSettingsMap: Record<string, MonthSettings> = {};
        try {
            const sheetSnap = await getDoc(doc(firestore, `groups/${groupId}/sheetSettings`, "default"));
            sheetSettings = sheetSnap.exists() ? (sheetSnap.data() as SheetSettings) : null;
            const monthSettingsSnap = await getDocs(collection(firestore, `groups/${groupId}/monthSettings`));
            monthSettingsSnap.docs.forEach(d => { monthSettingsMap[d.id] = d.data() as MonthSettings; });
        } catch (error) {
            console.error("Could not load sheet settings:", error);
        }

        let loopMonth = startOfMonth(new Date());

        while (loopMonth >= startOfMonth(firstJoinDate)) {
            const monthStart = startOfMonth(loopMonth);
            const monthEnd = endOfMonth(loopMonth);

            const mealsQuery = query(collection(firestore, `groups/${groupId}/meals`), where("date", ">=", monthStart), where("date", "<=", monthEnd));
            const expensesQuery = query(collection(firestore, `groups/${groupId}/expenses`), where("date", ">=", monthStart), where("date", "<=", monthEnd));
            const membersQuery = query(collection(firestore, `groups/${groupId}/members`));
            const settlementsQuery = query(collection(firestore, `groups/${groupId}/settlements`), where("month", "==", getMonth(loopMonth) + 1), where("year", "==", getYear(loopMonth)));
            
            // Fix: আগে members query দুবার পড়া হতো (usersSnapshot নামে)। নাম/ছবি profileMap থেকেই আসে।
            const [mealsSnapshot, expensesSnapshot, membersSnapshot, settlementsSnapshot] = await Promise.all([
                getDocs(mealsQuery),
                getDocs(expensesQuery),
                getDocs(membersQuery),
                getDocs(settlementsQuery)
            ]);

            const mealsData = mealsSnapshot.docs.map(d => d.data() as MealLog);
            const expensesData = expensesSnapshot.docs.map(d => d.data() as Expense);
            const membersData = membersSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as Member));
            const settlementsData = settlementsSnapshot.docs.map(d => d.data() as Settlement);
            
            const userMap: Record<string, any> = { ...profileMap };

            // Filter members who were active during the loopMonth
            const activeMembersInMonth = membersData.filter(m => {
                const joinedAt = toJsDate(m.joinedAt);
                const leftAt = toJsDate(m.leftAt);
                return (!joinedAt || joinedAt <= monthEnd) && (!leftAt || leftAt >= monthStart);
            });

            const mealsByUser = mealsData.reduce((acc, meal) => { (acc[meal.userId] = acc[meal.userId] || []).push(meal); return acc; }, {} as Record<string, MealLog[]>);
            const expensesByUser = expensesData.reduce((acc, expense) => { (acc[expense.userId] = acc[expense.userId] || []).push(expense); return acc; }, {} as Record<string, Expense[]>);
            const settlementsByUser = settlementsData.reduce((acc, settlement) => { acc[settlement.userId] = settlement; return acc; }, {} as Record<string, Settlement>);

            const monthCalc = computeMonth({
                members: activeMembersInMonth,
                meals: mealsData,
                expenses: expensesData,
                leaves: leavesData,
                adjustments: allAdjustments.filter(a => a.monthKey === monthKeyOf(monthStart)),
                monthStart,
                monthEnd,
                leaveCategories: sheetSettings?.leaveCategories,
                minLeaveDays: sheetSettings?.minLeaveDays,
                splitMembers: monthSettingsMap[monthKeyOf(monthStart)]?.splitMembers,
            });

            const processedMembers = activeMembersInMonth.map(member => {
                const userDetails = userMap[member.id];
                const memberMeals = mealsByUser[member.id] || [];
                const memberExpenses = expensesByUser[member.id] || [];
                const memberCalc = monthCalc.byMember[member.id];
                const totalPaid = memberExpenses.reduce((sum, e) => sum + e.amount, 0) + (memberCalc?.paidAdjustment || 0);
                const totalShare = memberCalc?.settlementShare ?? 0;
                const balance = totalPaid - totalShare;

                return {
                    id: member.id,
                    name: userDetails?.displayName || userDetails?.email?.split('@')[0] || memberMeals[0]?.userName || memberExpenses[0]?.userName || 'Unnamed Member',
                    photoURL: userDetails?.photoURL,
                    totalPaid,
                    totalShare,
                    electricityShare: memberCalc?.electricityShare ?? 0,
                    gasShare: memberCalc?.gasShare ?? 0,
                    wifiShare: memberCalc?.wifiShare ?? 0,
                    etcShare: memberCalc?.etcShare ?? 0,
                    balance,
                    isSettled: !!settlementsByUser[member.id],
                    settlementDetails: settlementsByUser[member.id],
                };
            });

            const totalGroupExpenses = activeMembersInMonth.reduce(
                (sum, member) => sum + (monthCalc.byMember[member.id]?.total ?? 0),
                0
            );
            const mealRate = monthCalc.mealRate;

            if (mealsData.length > 0 || expensesData.length > 0) {
              monthlyRecords.push({
                  month: loopMonth,
                  processedMembers,
                  totalGroupExpenses,
                  mealRate,
              });
            }

            loopMonth = subMonths(loopMonth, 1);
        }

        setHistory(monthlyRecords);
        setIsLoadingHistory(false);
    };

    if (groupId) {
        fetchHistory();
    }
  }, [groupId, firestore]);

  const isLoading = isUserLoading || isCurrentUserDataLoading || isLoadingHistory;

  if (isLoading) {
    return <HistorySkeleton />;
  }

  if (!groupId) {
    return <WelcomeCard />;
  }

  if (history.length === 0) {
      return (
          <Card>
              <CardContent className="text-center py-16">
                  <Scale className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-xl font-semibold">No History Yet</h3>
                  <p className="text-muted-foreground">Once you complete a month of tracking, your settlement history will appear here.</p>
              </CardContent>
          </Card>
      )
  }

  return (
    <div className="space-y-4">
      {history.map(({ month, processedMembers, totalGroupExpenses, mealRate }) => {
        const monthForSettlement = getMonth(month) + 1;
        const yearForSettlement = getYear(month);

        return (
            <Card key={month.toISOString()}>
            <Collapsible>
                <CollapsibleTrigger className="flex justify-between items-center w-full p-4 group">
                    <CardHeader className="p-0 text-left">
                        <CardTitle>{format(month, "MMMM yyyy")}</CardTitle>
                        <CardDescription>Total Expenses: ৳{totalGroupExpenses.toFixed(2)} | Meal Rate: ৳{mealRate.toFixed(2)}</CardDescription>
                    </CardHeader>
                    <ChevronDown className="h-5 w-5 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <CardContent>
                       {processedMembers.map(member => (
                         <div key={member.id} className="flex flex-col md:flex-row items-start md:items-center justify-between p-3 border-t first:border-t-0">
                           <div className="flex items-center gap-3 flex-1 mb-3 md:mb-0">
                               <Avatar>
                                 <AvatarImage src={member.photoURL}/>
                                 <AvatarFallback>{member.name.charAt(0)}</AvatarFallback>
                               </Avatar>
                               <div className="flex-1">
                                 <p className="font-semibold">{member.name}</p>
                                 <p className="mt-1 text-xs text-muted-foreground">
                                   Utilities share: Electricity ৳{member.electricityShare.toFixed(2)} · Gas ৳{member.gasShare.toFixed(2)} · Wi-Fi ৳{member.wifiShare.toFixed(2)}
                                 </p>
                                 <p className="text-xs text-muted-foreground">
                                   ETC share: ৳{member.etcShare.toFixed(2)} · Total share: ৳{member.totalShare.toFixed(2)} · Total paid: ৳{member.totalPaid.toFixed(2)}
                                 </p>
                                 <div className={cn("font-bold text-lg", member.balance >= 0 ? 'text-green-600' : 'text-red-600')}>
                                   {member.balance >= 0 ? `Gets: ` : `Owes: `}
                                   ৳{Math.abs(member.balance).toFixed(2)}
                                 </div>
                               </div>
                           </div>
                           <div className="w-full md:w-auto">
                           {member.isSettled ? (
                                <Alert className="bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-300">
                                    <CheckCircle className="h-4 w-4 !text-green-600" />
                                    <AlertTitle className="text-sm font-semibold">Settled!</AlertTitle>
                                    <AlertDescription className="text-xs">
                                        Paid to {member.settlementDetails?.settledTo} via {member.settlementDetails?.settlementMethod}.
                                    </AlertDescription>
                                </Alert>
                            ) : (
                               <SettleUpDialog
                                 member={{ id: member.id, name: member.name, balance: member.balance }}
                                 amountDue={-member.balance}
                                 month={monthForSettlement}
                                 year={yearForSettlement}
                                 groupId={groupId}
                                 currentUserId={currentUser!.uid}
                                 currentUserName={currentUserName}
                                 members={processedMembers.map((m) => ({ id: m.id, name: m.name, balance: m.balance }))}
                                 currentUserIsAdmin={currentUserIsAdmin}
                               />
                            )}
                           </div>
                         </div>
                       ))}
                    </CardContent>
                </CollapsibleContent>
            </Collapsible>
            </Card>
        )
      })}
    </div>
  );
}
