# WhatsApp supplier questions: setup

Mill Mate asks a supplier on WhatsApp whether the material is available and when it
can be delivered, reads the reply, and sets the order's Expected Dispatch Date.
It talks to Meta's WhatsApp Cloud API directly (no Twilio or other middleman).

Status (2026-10-22): the code is finished and tested against a fake WhatsApp
(Part B). Part A (Meta setup) and Part C (connect and test) are still to do.

## Part A: Meta setup (company does this, about 1-2 hours plus Meta approval)

### A1. New SIM
- Prepaid SIM in the company's name (Jio or Airtel), in any phone that can receive SMS.
- **Do not install WhatsApp or WhatsApp Business on this number.**
- The existing business WhatsApp number stays as it is for normal chats.

### A2. Meta Business account (skip if one exists)
1. business.facebook.com -> Create account: "Alagiri Duplex Paper Mills", email mill_mate@alagiriduplex.com.
2. Settings -> Business info: address and website.
3. Security centre -> Start verification: upload the GST certificate (takes a few days; carry on meanwhile).

### A3. Developer app and the new number
1. developers.facebook.com -> My Apps -> Create app -> Other -> Business. Name "Mill Mate", pick the business account.
2. In the app: WhatsApp -> Set up.
3. WhatsApp -> API Setup -> Add phone number:
   - Display name: Alagiri Duplex Paper Mills
   - Category: Industrial (or nearest)
   - Number: the new SIM
4. Enter the SMS code.

### A4. Payment method
WhatsApp Manager -> Settings -> Payment methods -> Add card.

### A5. Message template
WhatsApp Manager -> Message templates -> Create template
- Category: **Utility**, name: `material_availability`, language: **English**
- Body (exactly):
  ```
  Hello, this is Alagiri Duplex Paper Mills. Is {{1}} available for our order {{2}}? Please tap a button below.
  ```
  Examples: {{1}} = `Bearing (10 pcs)`, {{2}} = `PO-2026-123456`
- Buttons: Quick reply, **in this order**: `Available`, `Not available`
- Submit (approval takes minutes to a day).

### A6. Permanent access token
1. business.facebook.com -> Settings -> Users -> System users -> Add: "millmate-server", role Admin.
2. Assign assets -> Mill Mate app -> Full control.
3. Generate token -> Mill Mate app, expiry **Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Copy it immediately (shown once).

### A7. Hand over the settings in a file (never in chat)
```
Phone number ID: (WhatsApp -> API Setup, under the number)
Access token:    (A6)
App secret:      (App settings -> Basic -> App secret)
Template:        material_availability (approved? yes/no)
```

## Part C: Connect and test (developer + company, about 30 minutes)
1. Developer adds to `/etc/millmate.env` on the server, then restarts it:
   `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`,
   `META_WEBHOOK_VERIFY_TOKEN` (a new random string), `META_AVAILABILITY_TEMPLATE_NAME=material_availability`,
   `META_TEMPLATE_LANGUAGE=en` (must match the template's language code), optionally `WHATSAPP_REMINDER_HOURS=24`.
2. Meta app -> WhatsApp -> Configuration -> Webhook:
   - Callback URL: `https://api.alagiriduplex.com/api/whatsapp/inbound`
   - Verify token: the `META_WEBHOOK_VERIFY_TOKEN` value
   - Subscribe to **messages**.
3. Test with your own phone as the supplier: put your number on a test supplier, create and approve an
   order, tap "Ask Supplier: Available? Date?" in Order Details, tap Available, reply "25/10",
   and check the Expected Dispatch Date, the Acknowledged status and the notification.
4. Then try one real supplier.

## How it works (for reference)
- Code: `server/routes/whatsapp.js` (flow), `server/supplierReply.js` (reads yes/no and dates, India time),
  `server/whatsapp.js` (Meta API), Order Details "Supplier on WhatsApp" box in `src/components/Views.jsx`.
- Tests: `cd server && npm test`.
- Unreadable replies: asks the supplier once more, then notifies the admin with a "Set Delivery Date" button. It never guesses a date.
