# Bitrix24 MCP Server

MCP-сервер для подключения ассистента к Bitrix24 через входящий webhook.

## Возможности

- Проверка профиля webhook-пользователя.
- Вызов любого метода Bitrix24 REST API.
- Просмотр, создание и обновление лидов.
- Просмотр и создание сделок.
- Получение описания CRM-полей.

## Установка

```bash
npm install
npm run build
```

## Настройка

Создайте `.env` рядом с `package.json`:

```bash
BITRIX24_WEBHOOK_BASE_URL=https://your-domain.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx
```

Важно: не добавляйте настоящий webhook в git.

Если у вас полный URL заканчивается на `/profile.json`, можно указать его без `/profile.json`:

```bash
BITRIX24_WEBHOOK_BASE_URL=https://pro-adminov.bitrix24.ru/rest/1/YOUR_SECRET_CODE
```

## Запуск

```bash
npm start
```

## MCP config

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "node",
      "args": ["/absolute/path/to/bitrix24-mcp-server/dist/index.js"],
      "env": {
        "BITRIX24_WEBHOOK_BASE_URL": "https://pro-adminov.bitrix24.ru/rest/1/YOUR_SECRET_CODE"
      }
    }
  }
}
```

## Инструменты

- `bitrix24_profile`
- `bitrix24_call_method`
- `bitrix24_list_leads`
- `bitrix24_get_lead`
- `bitrix24_create_lead`
- `bitrix24_update_lead`
- `bitrix24_list_deals`
- `bitrix24_create_deal`
- `bitrix24_get_fields`

## Безопасность

Webhook, отправленный в чат, нужно считать скомпрометированным. После проверки создайте новый incoming webhook в Bitrix24 и удалите старый.
