function textContent(value) {
  return [{ type: "text", text: { content: value == null ? "" : String(value).slice(0, 2000) } }];
}

export function getPlainText(propertyValue) {
  if (!propertyValue) return "";

  switch (propertyValue.type) {
    case "title":
      return propertyValue.title.map((part) => part.plain_text).join("");
    case "rich_text":
      return propertyValue.rich_text.map((part) => part.plain_text).join("");
    case "select":
      return propertyValue.select?.name || "";
    case "status":
      return propertyValue.status?.name || "";
    case "url":
      return propertyValue.url || "";
    case "email":
      return propertyValue.email || "";
    case "phone_number":
      return propertyValue.phone_number || "";
    case "number":
      return propertyValue.number == null ? "" : String(propertyValue.number);
    default:
      return "";
  }
}

export function filterForExactValue(propertyName, propertySchema, value) {
  switch (propertySchema.type) {
    case "title":
      return { property: propertyName, title: { equals: value } };
    case "rich_text":
      return { property: propertyName, rich_text: { equals: value } };
    case "select":
      return { property: propertyName, select: { equals: value } };
    case "status":
      return { property: propertyName, status: { equals: value } };
    case "url":
      return { property: propertyName, url: { equals: value } };
    case "email":
      return { property: propertyName, email: { equals: value } };
    case "phone_number":
      return { property: propertyName, phone_number: { equals: value } };
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error(`Cannot query non-numeric value "${value}" against number property "${propertyName}"`);
      }
      return { property: propertyName, number: { equals: number } };
    }
    default:
      throw new Error(
        `Property "${propertyName}" has unsupported lookup type "${propertySchema.type}". Use a title/rich_text property for RFID Tag UID.`
      );
  }
}

export function checkboxFilter(propertyName, expected) {
  return { property: propertyName, checkbox: { equals: expected } };
}

export function propertyPayload(propertyName, propertySchema, value) {
  if (value === undefined) return null;

  switch (propertySchema.type) {
    case "title":
      return [propertyName, { title: textContent(value) }];
    case "rich_text":
      return [propertyName, { rich_text: textContent(value) }];
    case "number":
      return [propertyName, { number: value == null || value === "" ? null : Number(value) }];
    case "checkbox":
      return [propertyName, { checkbox: Boolean(value) }];
    case "date":
      return [propertyName, { date: value ? { start: value instanceof Date ? value.toISOString() : String(value) } : null }];
    case "select":
      return [propertyName, value ? { select: { name: String(value) } } : { select: null }];
    case "status":
      return [propertyName, value ? { status: { name: String(value) } } : { status: null }];
    case "multi_select": {
      const values = Array.isArray(value) ? value : value ? [value] : [];
      return [propertyName, { multi_select: values.map((item) => ({ name: String(item) })) }];
    }
    case "url":
      return [propertyName, { url: value ? String(value) : null }];
    case "email":
      return [propertyName, { email: value ? String(value) : null }];
    case "phone_number":
      return [propertyName, { phone_number: value ? String(value) : null }];
    default:
      return null;
  }
}
