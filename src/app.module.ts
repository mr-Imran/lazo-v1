import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthController } from './auth/auth.controller.js';
import { ClerkAuthGuard } from './auth/clerk-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { UserRoleService } from './auth/user-role.service.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminUsersService } from './admin/admin-users.service.js';
import { EventsController } from './events/events.controller.js';
import { EventTypesController } from './events/event-types.controller.js';
import { EventsService } from './events/events.service.js';
import { SubEventsService } from './events/sub-events.service.js';
import { isObserveConfigured } from './observe.config.js';
import { supabaseProvider } from './supabase/supabase.provider.js';
import { PayloadCryptoService, PayloadEncryptionInterceptor } from './crypto/index.js';
import { ApiController } from './meta/api.controller.js';
import { HealthController } from './meta/health.controller.js';
import { ApiKeysController } from './api-keys/api-keys.controller.js';
import { ApiKeysService } from './api-keys/api-keys.service.js';
import { DynamicController } from './dynamic/dynamic.controller.js';
import { DynamicService } from './dynamic/dynamic.service.js';
import { UsersController } from './users/users.controller.js';
import { ClerkWebhookController } from './users/clerk-webhook.controller.js';
import { UsersService } from './users/users.service.js';
import { WebsiteController } from './website/website.controller.js';
import { WebsiteService } from './website/website.service.js';
import { ThemeAdminController } from './website/theme-admin.controller.js';
import { ThemeAdminService } from './website/theme-admin.service.js';
import { SitesController } from './sites/sites.controller.js';
import { SitesService } from './sites/sites.service.js';
import {
  LazoProductsAdminController,
  MarketplaceController,
  VendorAdminController,
  VendorController,
} from './vendors/vendors.controller.js';
import { VendorsService } from './vendors/vendors.service.js';
import { VendorAdminService } from './vendors/vendor-admin.service.js';
import { MarketplaceService } from './vendors/marketplace.service.js';
import { LazoProductsService } from './vendors/lazo-products.service.js';
import { HomeAdminController, HomeController } from './home/home.controller.js';
import { HomeService } from './home/home.service.js';
import { GuestsController, RsvpController } from './guests/guests.controller.js';
import { GuestsService } from './guests/guests.service.js';
import { PublicSiteActionsController, SiteContentController } from './site-content/site-content.controller.js';
import { SiteContentService } from './site-content/site-content.service.js';
import { RegistryService } from './site-content/registry.service.js';
import { PlanningController, VendorInquiriesController } from './planning/planning.controller.js';
import { PlanningService } from './planning/planning.service.js';
import { AdminActivityController } from './planning/admin-activity.controller.js';
import { MediaAdminController } from './admin/media-admin.controller.js';
import { MediaService } from './admin/media.service.js';
import { PaymentsAdminController, PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { ChatAdminController, ChatController, PublicChatController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { ChatEventsService } from './chat/chat.events.js';
import { MessagingService } from './messaging/messaging.service.js';
import { PhotosService } from './photos/photos.service.js';
import { SeatingService } from './seating/seating.service.js';
import { ConciergeService } from './concierge/concierge.service.js';
import {
  ConciergeAdminController,
  EventFeaturesController,
  MessagingConfigController,
  PublicPhotosController,
} from './features/features.controller.js';
// A-core: anonymous drafts, invoices, post-event flow, seating export.
import { DraftsController } from './drafts/drafts.controller.js';
import { InvoicesAdminController, InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { AfterEventController } from './after-event/after-event.controller.js';
import { SeatingExportController } from './seating/seating.controller.js';
// B-vendor-payments: Stripe Connect quotes, orders, refunds, reconciliation.
import {
  HostOrdersController,
  VendorPaymentsAdminController,
  VendorPaymentsController,
} from './vendor-payments/vendor-payments.controller.js';
import { VendorConnectService } from './vendor-payments/vendor-connect.service.js';
import { VendorQuotesService } from './vendor-payments/vendor-quotes.service.js';
import { VendorOrdersService } from './vendor-payments/vendor-orders.service.js';
import { VendorPaymentsAdminService } from './vendor-payments/vendor-payments-admin.service.js';
// C-whatsapp: Meta WhatsApp Business Cloud API.
import { WhatsAppAdminController, WhatsAppController, WhatsAppPublicController } from './whatsapp/whatsapp.controller.js';
import { WhatsAppService } from './whatsapp/whatsapp.service.js';
// D-retail-fulfilment: retailer catalogs (Amazon PA-API, Mercado Libre) and print/flowers/travel partners.
import {
  EventRegistryRetailerController,
  PublicRegistryClickController,
  RetailersController,
} from './retailers/retailers.controller.js';
import { RetailersService } from './retailers/retailers.service.js';
import {
  EventFulfilmentController,
  FulfilmentAdminController,
  PartnerFulfilmentController,
} from './fulfilment/fulfilment.controller.js';
import { FulfilmentService } from './fulfilment/fulfilment.service.js';
// E-modes-gateway: memorial condolences and the Mercado Pago gateway.
import { CondolencesController, PublicCondolencesController } from './site-content/condolences.controller.js';
import { CondolencesService } from './site-content/condolences.service.js';
import { MercadoPagoService } from './payments/mercadopago.service.js';
// F-analytics: warehouse reads, scheduled ingest, revenue reconciliation.
import { AnalyticsAdminController, EventAnalyticsController } from './analytics/analytics.controller.js';
import { AnalyticsService } from './analytics/analytics.service.js';
import { AnalyticsIngestService } from './analytics/analytics-ingest.service.js';
import { AnalyticsReconcileService } from './analytics/analytics-reconcile.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

// Distributed tracing, auto-correlated logs, request/job metrics, error
// telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
const observeImports = isObserveConfigured()
  ? [
      ObserveModule.forRoot({
        appKey: process.env.OBSERVE_APP_KEY!,
        appSecret: process.env.OBSERVE_APP_SECRET!,
        runtimeMetrics: !process.versions?.['webcontainer'],
        serviceId: 'nest-typescript-starter',
      }),
    ]
  : [];

@Module({
  imports: [DiscoveryModule, ...observeImports],
  controllers: [
    AppController,
    ApiController,
    HealthController,
    AuthController,
    EventsController,
    EventTypesController,
    ApiKeysController,
    DynamicController,
    AdminController,
    UsersController,
    ClerkWebhookController,
    WebsiteController,
    ThemeAdminController,
    SitesController,
    VendorController,
    VendorAdminController,
    LazoProductsAdminController,
    MarketplaceController,
    HomeController,
    HomeAdminController,
    GuestsController,
    RsvpController,
    // D: listed before SiteContentController (both live under api/events/:id/registry).
    EventRegistryRetailerController,
    SiteContentController,
    PublicSiteActionsController,
    PlanningController,
    VendorInquiriesController,
    AdminActivityController,
    MediaAdminController,
    PaymentsController,
    PaymentsAdminController,
    EventFeaturesController,
    PublicPhotosController,
    ConciergeAdminController,
    MessagingConfigController,
    ChatController,
    ChatAdminController,
    PublicChatController,
    // A-core
    DraftsController,
    InvoicesController,
    InvoicesAdminController,
    AfterEventController,
    SeatingExportController,
    // B-vendor-payments
    VendorPaymentsController,
    HostOrdersController,
    VendorPaymentsAdminController,
    // C-whatsapp
    WhatsAppController,
    WhatsAppPublicController,
    WhatsAppAdminController,
    // D-retail-fulfilment
    RetailersController,
    PublicRegistryClickController,
    EventFulfilmentController,
    PartnerFulfilmentController,
    FulfilmentAdminController,
    // E-modes-gateway
    CondolencesController,
    PublicCondolencesController,
    // F-analytics
    AnalyticsAdminController,
    EventAnalyticsController,
  ],
  providers: [
    AppService,
    supabaseProvider,
    EventsService,
    SubEventsService,
    ApiKeysService,
    DynamicService,
    UsersService,
    WebsiteService,
    ThemeAdminService,
    SitesService,
    VendorsService,
    VendorAdminService,
    MarketplaceService,
    LazoProductsService,
    HomeService,
    MediaService,
    GuestsService,
    SiteContentService,
    RegistryService,
    PlanningService,
    PaymentsService,
    MessagingService,
    PhotosService,
    SeatingService,
    ConciergeService,
    ChatService,
    ChatEventsService,
    UserRoleService,
    AdminUsersService,
    // A-core (PaymentsService injects InvoicesService)
    InvoicesService,
    // B-vendor-payments
    VendorConnectService,
    VendorQuotesService,
    VendorOrdersService,
    VendorPaymentsAdminService,
    // C-whatsapp
    WhatsAppService,
    // D-retail-fulfilment
    RetailersService,
    FulfilmentService,
    // E-modes-gateway (PaymentsService injects MercadoPagoService)
    CondolencesService,
    MercadoPagoService,
    // F-analytics (AnalyticsIngestService starts its own timer on module init)
    AnalyticsService,
    AnalyticsIngestService,
    AnalyticsReconcileService,
    // Order matters: authenticate first, then check @Roles on top of it.
    { provide: APP_GUARD, useClass: ClerkAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Wraps every /api payload once the guards have had their say.
    PayloadCryptoService,
    { provide: APP_INTERCEPTOR, useClass: PayloadEncryptionInterceptor },
  ],
})
export class AppModule {}
