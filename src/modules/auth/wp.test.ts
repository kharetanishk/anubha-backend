import dotenv from "dotenv";
import axios from "axios";
dotenv.config();

async function sendTemplateMsg() {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: "919713885582",
        type: "template",
        template: {
          name: "hello_world",
          language: { code: "en_US" },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    // console.log("Sent:", response.data);
  } catch (err: any) {
    console.error("Error:", err.response?.data || err.message);
  }
}

sendTemplateMsg();
