function textContent(value) {
  return [{ type: "text", text: { content: value == null ? "" : String(value).slice(0, 2000) } }];
}

function propertyIdentifier(propertyName, propertySchema) {
  return propertySchema?.id || propertyName;
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
  const property = propertyIdentifier(propertyName, propertySchema);

  switch (propertySchema.type) {
    case "title":
      return { property, title: { equals: value } };
    case "rich_text":
      return { property, rich_text: { equals: value } };
    case "select":
      return { property, select: { equals: value } };
    case "status":
      return { property, status: { equals: value } };
    case "url":
      return { property, url: { equals: value } };
    case "email":
      return { property, email: { equals: value } };
    case "phone_number":
      return { property, phone_number: { equals: value } };
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error(`Cannot query non-numeric value "${value}" against number property "${propertyName}"`);
      }
      return { property, number: { equals: number } };
    }
    default:
      throw new Error(
        `Property "${propertyName}" has unsupported lookup type "${propertySchema.type}". Use a title/rich_text property for RFID Tag UID.`
      );
  }
}

export function checkboxFilter(propertyName, expected, propertySchema = null) {
  return { property: propertyIdentifier(propertyName, propertySchema), checkbox: { equals: expected } };
}

export function propertyPayload(propertyName, propertySchema, value) {
  if (value === undefined) return null;

  const property = propertyIdentifier(propertyName, propertySchema);

  switch (propertySchema.type) {
    case "title":
      return [property, { title: textContent(value) }];
    case "rich_text":
      return [property, { rich_text: textContent(value) }];
    case "number":
      return [property, { number: value == null || value === "" ? null : Number(value) }];
    case "checkbox":
      return [property, { checkbox: Boolean(value) }];
    case "date":
      return [property, { date: value ? { start: value instanceof Date ? value.toISOString() : String(value) } : null }];
    case "select":
      return [property, value ? { select: { name: String(value) } } : { select: null }];
    case "status":
      return [property, value ? { status: { name: String(value) } } : { status: null }];
    case "multi_select": {
      const values = Array.isArray(value) ? value : value ? [value] : [];
      return [property, { multi_select: values.map((item) => ({ name: String(item) })) }];
    }
    case "url":
      return [property, { url: value ? String(value) : null }];
    case "email":
      return [property, { email: value ? String(value) : null }];
    case "phone_number":
      return [property, { phone_number: value ? String(value) : null }];
    default:
      return null;
  }
}
