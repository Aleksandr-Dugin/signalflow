import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "./_core/trpc";
import { getDb } from "./_core/database";
import * as schema from "../drizzle/schema";
import { PLANS, getActivePaidPlans } from "../shared/plans";
import { demoProspects, DEMO_DISCLOSURE } from "../shared/demo";
import { getEntitlements } from "./services/entitlements";
import { getBillingStatus } from "./services/billing";
import { getBillingProvider } from "./services/billingService";
import { sendOutreachEmail, makeIdempotencyKey, OutreachError } from "./services/outreach";
import { isProviderConfigured } from "./_core/oauth";
import {
  createCampaign,
  generateIcpForWorkspace,
  generatePersonalization,
  getProfile,
  getProspectDetail,
  getProspectThread,
  isAutopilotEnabled,
  listCampaigns,
  listOpportunities,
  listProspects,
  resolveWorkspace,
  runDiscovery,
  saveManualIcp,
  setAutopilot,
  updateOpportunity,
  upsertProfile,
  adminOverview,
  adminListUsers,
  adminListWorkspaces,
  adminRecentJobs,
  adminSetRole,
  systemStatus,
} from "./db";

async function requireWorkspace(ctx: { user: { id: string } }): Promise<string> {
  return resolveWorkspace(ctx.user.id);
}

export const appRouter = router({
  meta: router({
    plans: publicProcedure.query(() => ({
      plans: Object.values(PLANS),
      paid: getActivePaidPlans(),
    })),
    // Landing-page demo: always clearly fictional, never touches the DB.
    demoLeads: publicProcedure.query(() => ({
      disclosure: DEMO_DISCLOSURE,
      prospects: demoProspects,
    })),
  }),

  auth: router({
    providers: publicProcedure.query(() => ({
      google: isProviderConfigured("google"),
      github: isProviderConfigured("github"),
      email: true,
    })),
  }),

  workspace: router({
    me: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      const entitlements = await getEntitlements(workspaceId);
      return { user: ctx.user, workspaceId, entitlements };
    }),
    entitlements: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      return getEntitlements(workspaceId);
    }),
    profile: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      return getProfile(workspaceId);
    }),
    setProfile: protectedProcedure
      .input(
        z.object({
          serviceDescription: z.string().min(1),
          targetMarket: z.string().min(1),
          geography: z.string().min(1),
          goals: z.string().optional(),
          websiteUrl: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return upsertProfile(workspaceId, input);
      }),
    autopilot: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      return { enabled: await isAutopilotEnabled(workspaceId) };
    }),
    setAutopilot: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return { enabled: await setAutopilot(workspaceId, input.enabled) };
      }),
  }),

  icp: router({
    generate: protectedProcedure
      .input(z.object({ service: z.string().min(2), target: z.string().min(2), geography: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return generateIcpForWorkspace(workspaceId, input);
      }),
    save: protectedProcedure
      .input(
        z.object({
          criteria: z.object({
            industries: z.array(z.string()),
            companyTypes: z.array(z.string()),
            companySize: z.array(z.string()),
            geographies: z.array(z.string()),
            businessModels: z.array(z.string()),
            technologies: z.array(z.string()),
            likelyProblems: z.array(z.string()),
            buyingSignals: z.array(z.string()),
            exclusions: z.array(z.string()),
            narrative: z.string(),
          }),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return saveManualIcp(workspaceId, input.criteria);
      }),
    list: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      const db = getDb();
      if (!db) return [];
      return db
        .select()
        .from(schema.icps)
        .where(eq(schema.icps.workspaceId, workspaceId))
        .orderBy(schema.icps.createdAt);
    }),
  }),

  campaign: router({
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          offerDescription: z.string().min(1),
          targetDescription: z.string().min(1),
          geography: z.string().min(1),
          industry: z.string().min(1),
          companySize: z.string().optional(),
          prospectTarget: z.number().int().min(1).max(200).optional(),
          icpId: z.string().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return createCampaign(workspaceId, input);
      }),
    list: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      return listCampaigns(workspaceId);
    }),
    runDiscovery: protectedProcedure
      .input(z.object({ campaignId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        try {
          return await runDiscovery(workspaceId, input.campaignId);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "discovery failed" });
        }
      }),
    archive: protectedProcedure
      .input(z.object({ campaignId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        const db = getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "no db" });
        await db
          .update(schema.campaigns)
          .set({ status: "archived" })
          .where(and(eq(schema.campaigns.id, input.campaignId), eq(schema.campaigns.workspaceId, workspaceId)));
        return { ok: true };
      }),
  }),

  prospect: router({
    list: protectedProcedure
      .input(z.object({ campaignId: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return listProspects(workspaceId, input.campaignId ?? null);
      }),
    detail: protectedProcedure
      .input(z.object({ prospectId: z.string() }))
      .query(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return getProspectDetail(workspaceId, input.prospectId);
      }),
    personalize: protectedProcedure
      .input(z.object({ prospectId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return generatePersonalization(workspaceId, input.prospectId);
      }),
    outreach: protectedProcedure
      .input(
        z.object({
          prospectId: z.string(),
          subject: z.string().min(1),
          body: z.string().min(1),
          personalizationId: z.string().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        try {
          return await sendOutreachEmail({
            workspaceId,
            prospectId: input.prospectId,
            subject: input.subject,
            body: input.body,
            personalizationId: input.personalizationId ?? null,
            idempotencyKey: makeIdempotencyKey(workspaceId, input.prospectId, input.personalizationId ?? null),
          });
        } catch (err) {
          const message = err instanceof OutreachError ? err.message : err instanceof Error ? err.message : "send failed";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
      }),
    thread: protectedProcedure
      .input(z.object({ prospectId: z.string(), limit: z.number().int().min(1).max(50).optional() }))
      .query(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        return getProspectThread(workspaceId, input.prospectId, input.limit ?? 20);
      }),
  }),

  opportunity: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      return listOpportunities(workspaceId);
    }),
    update: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          stage: z.enum(["open", "responded", "meeting_booked", "negotiating", "won", "lost"]).optional(),
          valueCents: z.number().int().min(0).optional(),
          notes: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        const { id, ...patch } = input;
        return updateOpportunity(workspaceId, id, patch);
      }),
  }),

  billing: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      const workspaceId = await requireWorkspace(ctx);
      return getBillingStatus(workspaceId);
    }),
    checkout: protectedProcedure
      .input(z.object({ planId: z.enum(["starter", "pro", "agency"]) }))
      .mutation(async ({ ctx, input }) => {
        const workspaceId = await requireWorkspace(ctx);
        const base = (process.env.PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
        const provider = getBillingProvider();
        const result = await provider.createCheckout({
          workspaceId,
          planId: input.planId,
          customerEmail: ctx.user.email || null,
          successUrl: `${base}/app/billing?status=success`,
          cancelUrl: `${base}/app/billing?status=cancelled`,
        });
        return { redirectUrl: result.redirectUrl, provider: result.provider };
      }),
  }),

  admin: router({
    status: adminProcedure.query(() => systemStatus()),
    overview: adminProcedure.query(() => adminOverview()),
    users: adminProcedure
      .input(z.object({ limit: z.number().int().min(1).max(500).optional() }))
      .query(({ input }) => adminListUsers(input.limit ?? 100)),
    workspaces: adminProcedure
      .input(z.object({ limit: z.number().int().min(1).max(500).optional() }))
      .query(({ input }) => adminListWorkspaces(input.limit ?? 100)),
    recentJobs: adminProcedure
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
      .query(({ input }) => adminRecentJobs(input.limit ?? 50)),
    setRole: adminProcedure
      .input(z.object({ userId: z.string(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await adminSetRole(ctx.user.id, input.userId, input.role);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Failed to update role" });
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
