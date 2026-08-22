/**
 * Quick smoke test — classifies a sample ticket and prints the result.
 * Run: node scripts/test_classify.js
 * Requires OPENAI_API_KEY in env or .env file.
 */

require('dotenv').config();
const { classifyTicket } = require('../api/classifier');

const sampleTicket = {
  id: 'test-001',
  subject: 'Need to cancel my booking - my flight got cancelled',
  channel: 'email',
  tags: ['minded_email'],
  mindedTag: 'cancellation_request__customer_related__flight_train_cancellation',
  transcript: `Customer: Hi, I booked tickets for the Eiffel Tower tour on Oct 15 but my flight to Paris was just cancelled due to a strike. Can I please get a refund?
Agent: I'm sorry to hear about your flight cancellation. I can see your booking #HO123456. Since this is due to circumstances outside your control, I'll process a full refund for you.
Customer: Thank you so much! How long will it take?
Agent: The refund will be processed within 5-7 business days to your original payment method.`,
  createdAt: '2026-08-22T10:00:00Z'
};

(async () => {
  console.log('Classifying sample ticket...\n');
  try {
    const result = await classifyTicket(sampleTicket);
    console.log('=== Result ===');
    console.log('Full tag:    ', result.full_tag);
    console.log('L1:          ', result.l1);
    console.log('L2:          ', result.l2);
    console.log('L3:          ', result.l3);
    console.log('Confidence:  ', result.confidence);
    console.log('Action:      ', result.recommended_action);
    console.log('Gap?:        ', result.taxonomy_gap);
    console.log('Cost USD:    ', result.cost_usd.toFixed(6));
    console.log('Evidence:    ', result.evidence);
    if (result.taxonomy_gap) {
      console.log('Gap reason:  ', result.taxonomy_gap_reason);
      console.log('Suggested:   ', result.suggested_new_tag);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
