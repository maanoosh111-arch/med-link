import {
  claimOrderForSending,
  getAppConfig,
  getNextDueOrder,
  markOrderRetryOrFail,
  markOrderSent,
  recoverInterruptedSendingOrders,
  releaseOrderWithoutAttemptPenalty,
} from './db.ts';
import { logger } from './logger.ts';
import { toWhatsAppJid } from './phone.ts';
import { whatsappService } from './whatsapp.ts';

const RETRY_DELAYS_MS = [10_000, 30_000, 90_000, 270_000];
const POLL_INTERVAL_MS = 2500;

class NotificationQueueWorker {
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  start(): void {
    const recovered = recoverInterruptedSendingOrders();
    if (recovered > 0) {
      logger.warn('queue_recovered_interrupted_orders', { count: recovered });
    }

    whatsappService.on('ready', () => {
      void this.trigger();
    });

    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.trigger();
      }, POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async trigger(): Promise<void> {
    if (this.processing) return;
    if (!whatsappService.isConnected()) return;

    this.processing = true;
    try {
      while (whatsappService.isConnected()) {
        const nextOrder = getNextDueOrder(Date.now());
        if (!nextOrder) {
          break;
        }

        const claimed = claimOrderForSending(nextOrder.order_id);
        if (!claimed) {
          continue;
        }

        const attemptNumber = nextOrder.attempts + 1;
        logger.info('queue_dispatch_attempt', {
          orderId: nextOrder.order_id,
          attempt: attemptNumber,
        });

        try {
          const config = getAppConfig();
          const recipientJid = toWhatsAppJid(config.recipientNumber, config.defaultCountryCode);

          const result = await whatsappService.sendOrderMessage(
            recipientJid,
            nextOrder.formatted_message,
            nextOrder.payment_receipt_url,
          );

          markOrderSent(nextOrder.order_id, result.messageId, result.resolvedJid);
          logger.info('queue_dispatch_sent', {
            orderId: nextOrder.order_id,
            whatsappMessageId: result.messageId,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown WhatsApp send error';

          if (!whatsappService.isConnected()) {
            releaseOrderWithoutAttemptPenalty(
              nextOrder.order_id,
              'WhatsApp disconnected before send completed; waiting for reconnect',
            );
            logger.warn('queue_paused_disconnected', { orderId: nextOrder.order_id });
            break;
          }

          if (attemptNumber >= nextOrder.max_attempts) {
            markOrderRetryOrFail(nextOrder.order_id, 'failed', null, errorMessage);
            logger.error('queue_dispatch_failed_permanently', {
              orderId: nextOrder.order_id,
              attempt: attemptNumber,
              error: errorMessage,
            });
          } else {
            const backoffMs =
              RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)];
            const nextRetryAt = Date.now() + backoffMs;
            markOrderRetryOrFail(nextOrder.order_id, 'pending', nextRetryAt, errorMessage);
            logger.warn('queue_dispatch_retry_scheduled', {
              orderId: nextOrder.order_id,
              attempt: attemptNumber,
              retryInMs: backoffMs,
              error: errorMessage,
            });
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

export const queueWorker = new NotificationQueueWorker();
