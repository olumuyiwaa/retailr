import { Injectable } from "@nestjs/common";
import { AppError } from "../common/errors";
import { PrismaService } from "../prisma/prisma.service";

const CATEGORIES = ["rent", "utilities", "supplies", "marketing", "salaries", "transport", "other"] as const;
export type ExpenseCategory = (typeof CATEGORIES)[number];

type ExpenseCategoryDb =
  | "RENT"
  | "UTILITIES"
  | "SUPPLIES"
  | "MARKETING"
  | "SALARIES"
  | "TRANSPORT"
  | "OTHER";

const toExpense = (e: {
  id: string;
  businessId: string;
  amount: { toString(): string } | number;
  category: string;
  note: string;
  spentAt: Date;
  createdAt: Date;
}) => ({
  id: e.id,
  businessId: e.businessId,
  amount: Number(e.amount.toString()),
  category: e.category.toLowerCase() as ExpenseCategory,
  note: e.note,
  spentAt: e.spentAt.toISOString(),
  createdAt: e.createdAt.toISOString(),
});

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = await this.prisma.forBusiness(businessId).expense.findMany({
      where: {
        ...(opts.from || opts.to
          ? { spentAt: { ...(opts.from ? { gte: new Date(opts.from) } : {}), ...(opts.to ? { lte: new Date(opts.to) } : {}) } }
          : {}),
      },
      orderBy: { spentAt: "desc" },
      take,
    });
    return rows.map(toExpense);
  }

  async create(businessId: string, input: { amount: number; category: string; note?: string; spentAt: string }) {
    if (!(input.amount > 0)) throw AppError.badRequest("Enter an amount greater than zero.");
    const category = input.category?.toLowerCase();
    if (!CATEGORIES.includes(category as ExpenseCategory)) throw AppError.badRequest("Choose a valid expense category.");
    const spentAt = new Date(input.spentAt);
    if (Number.isNaN(spentAt.getTime())) throw AppError.badRequest("Enter a valid date.");
    const row = await this.prisma.forBusiness(businessId).expense.create({
      data: {
        businessId,
        amount: input.amount,
        category: category.toUpperCase() as ExpenseCategoryDb,
        note: (input.note ?? "").trim().slice(0, 500),
        spentAt,
      },
    });
    return toExpense(row);
  }

  async remove(businessId: string, id: string) {
    const r = await this.prisma.forBusiness(businessId).expense.deleteMany({ where: { id } });
    if (!r.count) throw AppError.notFound("Expense not found.");
  }

  /** Sum of expenses in a window. */
  async totalBetween(businessId: string, from: Date, to: Date) {
    const agg = await this.prisma.forBusiness(businessId).expense.aggregate({
      where: { spentAt: { gte: from, lt: to } },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }
}