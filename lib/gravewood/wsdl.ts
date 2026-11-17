const OPERATIONS: ReadonlyArray<{ name: string; documentation: string }> = [
  {
    name: "ListAccounts",
    documentation: "Lists every account with its balance and status. Read-only.",
  },
  {
    name: "GetBalance",
    documentation: "Returns the current balance of one account. Read-only.",
  },
  {
    name: "GetStatement",
    documentation:
      "Returns the transactions of one account, oldest first, optionally between two dates. Read-only.",
  },
  {
    name: "TransferFunds",
    documentation:
      "Moves money from one open account to another. A transfer can only be reversed by making another transfer.",
  },
  {
    name: "UpdateAddress",
    documentation:
      "Replaces the mailing address stored on an open account. The previous address is not kept.",
  },
  {
    name: "CloseAccount",
    documentation: "Permanently closes the account. This cannot be undone.",
  },
];

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Builds the Gravewood Bank WSDL 1.1 (document/literal, SOAP 1.1) for one sandbox endpoint. */
export function buildWsdl(endpointUrl: string): string {
  const messages = OPERATIONS.map(
    ({ name }) => `  <wsdl:message name="${name}Input">
    <wsdl:part name="parameters" element="tns:${name}"/>
  </wsdl:message>
  <wsdl:message name="${name}Output">
    <wsdl:part name="parameters" element="tns:${name}Response"/>
  </wsdl:message>`,
  ).join("\n");

  const portTypeOps = OPERATIONS.map(
    ({ name, documentation }) => `    <wsdl:operation name="${name}">
      <wsdl:documentation>${documentation}</wsdl:documentation>
      <wsdl:input message="tns:${name}Input"/>
      <wsdl:output message="tns:${name}Output"/>
    </wsdl:operation>`,
  ).join("\n");

  const bindingOps = OPERATIONS.map(
    ({ name }) => `    <wsdl:operation name="${name}">
      <soap:operation soapAction="urn:gravewood:${name}" style="document"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="GravewoodBank"
    targetNamespace="urn:gravewood"
    xmlns:tns="urn:gravewood"
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <wsdl:types>
    <xsd:schema targetNamespace="urn:gravewood" elementFormDefault="qualified">
      <xsd:simpleType name="AccountStatus">
        <xsd:restriction base="xsd:string">
          <xsd:enumeration value="OPEN"/>
          <xsd:enumeration value="CLOSED"/>
        </xsd:restriction>
      </xsd:simpleType>

      <xsd:element name="ListAccounts">
        <xsd:complexType/>
      </xsd:element>
      <xsd:element name="ListAccountsResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="account" maxOccurs="unbounded">
              <xsd:complexType>
                <xsd:sequence>
                  <xsd:element name="id" type="xsd:string"/>
                  <xsd:element name="name" type="xsd:string"/>
                  <xsd:element name="balance" type="xsd:decimal"/>
                  <xsd:element name="status" type="tns:AccountStatus"/>
                  <xsd:element name="openedOn" type="xsd:date"/>
                </xsd:sequence>
              </xsd:complexType>
            </xsd:element>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="GetBalance">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="accountId" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="GetBalanceResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="accountId" type="xsd:string"/>
            <xsd:element name="balance" type="xsd:decimal"/>
            <xsd:element name="asOf" type="xsd:dateTime"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="GetStatement">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="accountId" type="xsd:string"/>
            <xsd:element name="fromDate" type="xsd:date" minOccurs="0"/>
            <xsd:element name="toDate" type="xsd:date" minOccurs="0"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="GetStatementResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="accountId" type="xsd:string"/>
            <xsd:element name="transaction" minOccurs="0" maxOccurs="unbounded">
              <xsd:complexType>
                <xsd:sequence>
                  <xsd:element name="id" type="xsd:string"/>
                  <xsd:element name="timestamp" type="xsd:dateTime"/>
                  <xsd:element name="description" type="xsd:string"/>
                  <xsd:element name="amount" type="xsd:decimal"/>
                  <xsd:element name="memo" type="xsd:string" minOccurs="0" nillable="true"/>
                </xsd:sequence>
              </xsd:complexType>
            </xsd:element>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="TransferFunds">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="fromAccount" type="xsd:string"/>
            <xsd:element name="toAccount" type="xsd:string"/>
            <xsd:element name="amount" type="xsd:decimal"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="TransferFundsResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="confirmationId" type="xsd:string"/>
            <xsd:element name="fromBalance" type="xsd:decimal"/>
            <xsd:element name="toBalance" type="xsd:decimal"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="UpdateAddress">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="accountId" type="xsd:string"/>
            <xsd:element name="address" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="UpdateAddressResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="updated" type="xsd:boolean"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>

      <xsd:element name="CloseAccount">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="accountId" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="CloseAccountResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="closed" type="xsd:boolean"/>
            <xsd:element name="closedAt" type="xsd:dateTime"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>

${messages}

  <wsdl:portType name="GravewoodBankPortType">
${portTypeOps}
  </wsdl:portType>

  <wsdl:binding name="GravewoodBankBinding" type="tns:GravewoodBankPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
${bindingOps}
  </wsdl:binding>

  <wsdl:service name="GravewoodBank">
    <wsdl:port name="GravewoodBankSoap" binding="tns:GravewoodBankBinding">
      <soap:address location="${escapeAttribute(endpointUrl)}"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>
`;
}
