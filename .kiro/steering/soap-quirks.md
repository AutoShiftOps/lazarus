---
inclusion: fileMatch
fileMatchPattern: "lib/soap/**"
---
# SOAP quirks to handle

- SOAP 1.1 vs 1.2: different envelope namespaces and content types (`text/xml` + SOAPAction header vs `application/soap+xml`). Detect the version from the WSDL binding.
- Styles: support document/literal (most common) and rpc/literal. rpc/encoded is best-effort and must fail with a clear "unsupported" error.
- Namespaces: preserve target namespaces exactly; many services reject unqualified elements.
- Arrays: XML repeats elements. When the schema says maxOccurs > 1, a single item must still map to a JSON array.
- Nulls: map `xsi:nil="true"` to JSON `null`, and back.
- Types: string -> string; int/long -> integer; decimal/double/float -> number; boolean -> boolean; dateTime -> string with format date-time.
- Faults: map SOAP faults (faultcode, faultstring, detail) to an MCP tool error with a readable message.
- Timeouts: 10 seconds per call, reported as their own error type.
- Round-trip property: for any valid JSON input, building the SOAP envelope and parsing it back must return the same JSON. Keep translator functions pure so this can be property-tested.
