/*
 * Copyright © 2025-2026 Metreeca srl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

-- Base tables (joined table inheritance) ------------------------------------------------------------------------------

create table entity (
    "@" integer generated always as identity primary key
);

create table resource (

    "@"     integer primary key references entity ("@") on delete cascade,

    id      varchar(2000) not null unique,
    type    text          not null,

    created timestamp with time zone not null,
    updated timestamp with time zone

);

create table entity_label (

    entity integer     not null references entity ("@") on delete cascade,

    lang   varchar(10) not null,
    value  varchar(80) not null,

    primary key (entity, lang)

);

create table entity_comment (

    entity integer      not null references entity ("@") on delete cascade,

    lang   varchar(10)  not null,
    value  varchar(500) not null,

    primary key (entity, lang)

);


-- Category ------------------------------------------------------------------------------------------------------------

create table category (

    "@"      integer primary key references resource ("@") on delete cascade,

    code     varchar(4) not null unique,

    featured boolean    not null,

    parent   integer references category ("@")

);

create table category_title (

    category integer      not null references category ("@") on delete cascade,

    lang     varchar(10)  not null,
    value    text         not null,

    primary key (category, lang)

);

create table category_description (

    category integer      not null references category ("@") on delete cascade,

    lang     varchar(10)  not null,
    value    varchar(500) not null,

    primary key (category, lang)

);


-- Vendor --------------------------------------------------------------------------------------------------------------

create table vendor (

    "@"      integer primary key references resource ("@") on delete cascade,

    code     varchar(4)    not null unique,
    name     varchar(200)  not null,

    email    varchar(254)  not null,
    homepage varchar(2000) not null,

    founded  smallint,

    address_string          varchar(500),
    address_postaladdress  integer references entity ("@") on delete cascade

);

create table postal_address (

    "@"     integer      primary key references entity ("@") on delete cascade,

    street  varchar(200) not null,
    city    varchar(100) not null,
    zip     varchar(20)  not null,
    country varchar(100) not null

);


-- Product -------------------------------------------------------------------------------------------------------------

create table product (

    "@"       integer primary key references resource ("@") on delete cascade,

    sku       varchar(50)    not null unique,

    homepage  varchar(2000),

    launched  timestamp with time zone,
    warranty interval,

    condition text             not null default 'new',
    price     double precision not null,
    change    double precision,
    discount  double precision,
    stock     bigint           not null,

    vendor    integer        not null references vendor ("@")

);

create table product_name (

    product integer      not null references product ("@") on delete cascade,

    lang    varchar(10)  not null,
    value   varchar(200) not null,

    primary key (product, lang)

);

create table product_description (

    product integer       not null references product ("@") on delete cascade,

    lang    varchar(10)   not null,
    value   varchar(2000) not null,

    primary key (product, lang)

);

create table product_images (

    product integer       not null references product ("@") on delete cascade,

    url     varchar(2000) not null,

    primary key (product, url)

);

create table product_keywords (

    product integer      not null references product ("@") on delete cascade,

    lang    varchar(10)  not null,
    value   varchar(200) not null,

    primary key (product, lang, value)

);

create table product_categories (

    product  integer not null references product ("@") on delete cascade,
    category integer not null references category ("@"),

    primary key (product, category)

);


-- Review (embedded in Product, extends Entity) ------------------------------------------------------------------------

create table review (

    "@"     integer primary key references entity ("@") on delete cascade,

    product integer      not null references product ("@") on delete cascade,

    author  varchar(100) not null,
    posted  timestamp with time zone not null,
    rating  smallint     not null

);

create table review_content (

    review integer       not null references review ("@") on delete cascade,

    lang   varchar(10)   not null,
    value  varchar(5000) not null,

    primary key (review, lang)

);
