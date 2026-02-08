import {
  Body,
  Button,
  type ButtonProps,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Tailwind,
} from "@react-email/components";
import React from "react";

React;

type EmailLayoutProps = {
  children: React.ReactNode;
  preview?: string;
  heading: string;
};
export const EmailLayout = (props: EmailLayoutProps) => {
  const { children, preview, heading } = props;
  return (
    <Tailwind>
      <Html>
        <Head />
        <Preview>{preview ?? heading}</Preview>
        <Body className="bg-white py-8 font-sans text-gray-900">
          <Container className="text-center">
            <Heading>{heading}</Heading>
            {children}
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
};

EmailLayout.Button = ({ ...props }: ButtonProps) => {
  return (
    <Button
      className="rounded-md border-2 border-violet-700 border-solid bg-violet-600 px-8 py-2 text-lg text-white"
      {...props}
    />
  );
};
