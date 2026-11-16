# n8n-nodes-whatsapp-advanced

[![npm version](https://img.shields.io/npm/v/n8n-nodes-whatsapp-advanced.svg?style=flat-square&color=CB3837)](https://www.npmjs.com/package/n8n-nodes-whatsapp-advanced)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-whatsapp-advanced.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/n8n-nodes-whatsapp-advanced)
[![license](https://img.shields.io/npm/l/n8n-nodes-whatsapp-advanced.svg?style=flat-square&color=green)](https://github.com/AakashKhambhaliya/n8n-nodes-whatsapp-advanced/blob/main/LICENSE)
[![n8n community node](https://img.shields.io/badge/n8n-community%20node-FF6D5A?style=flat-square&logo=n8n&logoColor=white)](https://docs.n8n.io/integrations/community-nodes/)

> **The ultimate WhatsApp Business solution for n8n.** Effortlessly send automated WhatsApp messages, dynamic templates, marketing campaigns, and real-time delivery reports without complex setup.

---

## 🌟 Key Features

### ⚡ Smart Template Auto-Fill
Select any approved WhatsApp template and the node **automatically generates simple, labeled input fields** for every variable (`Name`, `Order ID`, `Tracking Link`, etc.) with example values. No manual formatting or coding required!

### 🔀 Dual API & Smart Routing
- **Cloud API (`/messages`)**: Perfect for transactional alerts, OTPs, and customer support.
- **Marketing Messages API (`/marketing_messages`)**: Built for high-volume marketing campaigns with higher delivery rates and click analytics.
- **Auto-Routing**: Automatically sends marketing templates through the Marketing Messages API and everything else through the Cloud API, and replays on the other route when Meta says the first one cannot take the message.

> Meta is retiring marketing templates on the Cloud API. Accounts that have switched them off already get error `131063` there, so keep marketing sends on **Auto** or **Marketing Messages API**.

### 👤 Phone Numbers and Usernames
Send to a phone number or to a WhatsApp business-scoped user ID (BSUID) from the same field — the node puts each in the right place for Meta, so recipients who hide their number behind a username are still reachable.

### 📊 Real-Time Delivery Tracking
Go beyond simple "Sent" receipts. Track when your messages are **Delivered**, **Read**, **Played** (voice messages), or **Failed**, with human-readable error descriptions if a message bounces. Each event carries the recipient's phone number and user ID when Meta provides them, plus the tracking reference that links it back to the original send.

### 🖼️ Rich Media & Interactive Templates
Send any template format seamlessly:
- 📷 **Images, Videos & Documents**
- 📍 **Location Pin Sharing**
- 🛍️ **Product Catalogs & Multi-Product Messages**
- 🎠 **Media & Product Carousel Cards**
- 🎟️ **Limited-Time Offers & Coupon Codes**
- 🔐 **OTP & One-Tap Authentication Messages**
- 🔘 **Quick Replies, Call Buttons & Flow Links**

### 🛡️ Smart Error Protection
- **Pre-Send Checks**: Catches missing details before sending so you don't burn API quota on broken messages.
- **Dry-Run Preview**: Test and preview your exact message copy before sending to real customers.
- **Automatic Retries**: Temporary Meta-side failures are retried with backoff, for both template and text messages.
- **Plain-Language Errors**: Every Meta error code comes with a next step, and tells you whether to retry now, retry later, stop sending to that recipient, or fix your setup.

---

## 🆕 What's New in 1.1.0

- Send to WhatsApp user IDs (BSUID) as well as phone numbers.
- Delivery events include user ID, username and the `played` status.
- Updated for Meta's 2026 error codes, with several error explanations corrected.
- Default Graph API version is now `v25.0`.
- Fixed the node icon appearing too small on the canvas.

Existing workflows keep working without changes. Full details are in the [changelog](CHANGELOG.md).

---

## 🚀 How to Install in n8n

### Method 1: n8n Community Nodes (Easiest)

1. Open your n8n workspace and go to **Settings → Community Nodes**.
2. Click **Install a community node**.
3. Type: `n8n-nodes-whatsapp-advanced`
4. Click **Install**.

---

## ⚙️ Quick Setup Guide

1. Go to your Meta Developer Dashboard and grab your **WhatsApp Access Token** & **Business Account ID**.
2. In n8n, create a new credential: **WhatsApp Advanced API**.
3. Enter your token and account ID — you're ready to automate!

The token needs both the `whatsapp_business_messaging` and `whatsapp_business_management` permissions; templates cannot be read without the second one. The credential's **Graph API Version** defaults to `v25.0` — leave it unless you need a specific version.

---

## 📄 License

Distributed under the [MIT License](LICENSE).
