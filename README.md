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
- **Auto-Routing**: Automatically picks the best route for your template and falls back if needed so your messages always land.

### 📊 Real-Time Delivery Tracking
Go beyond simple "Sent" receipts. Track when your messages are **Delivered**, **Read**, or **Failed**, with human-readable error descriptions if a message bounces.

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

---

## 📄 License

Distributed under the [MIT License](LICENSE).
