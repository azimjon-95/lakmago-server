import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { Expense } from '../models/Expense.js';

const CATEGORY_LABELS = {
  server: 'Server xarajati',
  tax: 'Soliq',
  income_tax: 'Daromad solig‘i',
  domain: 'Domen',
  bank_fee: 'Bank komissiyasi',
  fuel: 'Yo‘lkira',
  salary: 'Ish haqi',
  marketing: 'Reklama',
  other: 'Boshqa',
};

const expenseSchema = z.object({
  category: z.enum(['server', 'tax', 'income_tax', 'domain', 'bank_fee', 'fuel', 'salary', 'marketing', 'other']),
  amount: z.number().positive(),
  title: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
  date: z.string().optional(),
  recurring: z.boolean().optional(),
});

export const expenseController = {
  // GET /admin/expenses?month=2026-08
  list: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.month) {
      const [y, m] = req.query.month.split('-').map(Number);
      filter.date = {
        $gte: new Date(y, m - 1, 1),
        $lte: new Date(y, m, 0, 23, 59, 59, 999),
      };
    } else if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = new Date(req.query.from);
      if (req.query.to) filter.date.$lte = new Date(req.query.to);
    }
    if (req.query.category) filter.category = req.query.category;

    const items = await Expense.find(filter).sort({ date: -1 }).lean();

    const byCategory = {};
    let total = 0;
    for (const e of items) {
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
      total += e.amount;
    }

    res.json({
      items: items.map((e) => ({ ...e, categoryLabel: CATEGORY_LABELS[e.category] })),
      total,
      byCategory: Object.entries(byCategory).map(([category, amount]) => ({
        category, label: CATEGORY_LABELS[category], amount,
      })).sort((a, b) => b.amount - a.amount),
    });
  }),

  // POST /admin/expenses
  create: asyncHandler(async (req, res) => {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Noto‘g‘ri ma‘lumot', details: parsed.error.flatten() });
    }
    const expense = await Expense.create({
      ...parsed.data,
      date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
      createdBy: req.userId,
    });
    res.status(201).json(expense);
  }),

  // DELETE /admin/expenses/:id
  remove: asyncHandler(async (req, res) => {
    const deleted = await Expense.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Topilmadi' });
    res.json({ ok: true });
  }),
};
