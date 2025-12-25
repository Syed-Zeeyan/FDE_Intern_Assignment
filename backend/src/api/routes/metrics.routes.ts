import express, { Request, Response } from 'express';
import { metrics } from '../../utils/metrics';

/**
 * Metrics endpoint for Prometheus
 */

const router = express.Router();

/**
 * Prometheus metrics (text format)
 */
router.get('/', (req: Request, res: Response) => {
    const metricsText = metrics.getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metricsText);
});

/**
 * Metrics in JSON format
 */
router.get('/json', (req: Request, res: Response) => {
    const metricsJson = metrics.getMetricsJSON();
    res.json(metricsJson);
});

export default router;
