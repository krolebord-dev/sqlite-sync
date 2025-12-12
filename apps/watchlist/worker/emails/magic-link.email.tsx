import { Section, Text } from '@react-email/components';
import React from 'react';
import { EmailLayout } from './layout.email';

React;

export type MagicLinkEmailProps = {
  link: string;
  code: string;
};
export const MagicLinkEmail = (props: MagicLinkEmailProps) => {
  const { link, code } = props;
  return (
    <EmailLayout heading="Your login link">
      Your login code is:
      <Section>
        <Text className="font-semibold text-2xl">{code}</Text>
      </Section>
      <Section>
        <Text>Or use the link below:</Text>
      </Section>
      <Section>
        <EmailLayout.Button href={link}>Login</EmailLayout.Button>
      </Section>
    </EmailLayout>
  );
};

MagicLinkEmail.PreviewProps = {
  link: 'https://example.com',
  code: '123456',
};

export default MagicLinkEmail;
